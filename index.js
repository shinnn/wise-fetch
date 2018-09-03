'use strict';

const {inspect, types: {isNativeError, isSet}} = require('util');
const {join} = require('path');
const {METHODS} = require('http');
const readableAsyncIterator = require('stream').Readable.prototype[Symbol.asyncIterator];
const {tmpdir} = require('os');

const arrayToSentence = require('array-to-sentence');
const arrIndexesOf = require('arr-indexes-of');
const fromEntries = require('fromentries');
const inspectWithKind = require('inspect-with-kind');
const loadFromCwdOrNpm = require('load-from-cwd-or-npm');
const lowercaseKeys = require('lowercase-keys');
const rejectUnsatisfiedNpmVersion = require('reject-unsatisfied-npm-version');

const CACHE_DIR = join(tmpdir(), 'wise-fetch');
const CREATE_METHOD_SPECIFIC_OPTIONS = new Set(['additionalOptionValidators', 'frozenOptions', 'urlModifier']);
const CACHE_OPTIONS = new Set(['default', 'force-cache', 'no-cache', 'no-store', 'only-if-cached']);
const POSSIBLE_TYPOS = new Map([
	['baseuri', 'baseUrl'],
	['header', 'headers'],
	['redirects', 'redirect'],
	['caches', 'cache'],
	['follows', 'follow'],
	['maxsocket', 'maxSockets'],
	['proxies', 'proxy'],
	['compression', 'compress'],
	['resolveUnsuccessfulPromise', 'resolveUnsuccessfulResponse'],
	['resolveUnsuccessfulResponses', 'resolveUnsuccessfulResponse'],
	['resolveUnsuccesfulResponse', 'resolveUnsuccessfulResponse'],
	['resolveUnsucessfulResponse', 'resolveUnsuccessfulResponse']
]);
const PROXY_RELATED_ENVS = new Set(['https_proxy', 'http_proxy', 'proxy', 'no_proxy']);
const REDIRECT_OPTIONS = new Set(['error', 'follow', 'manual']);
const MINIMUM_REQUIRED_NPM_VERSION = '6.4.0';
const NOT_MODIFIED = 304;

const HAS_BASE_OPTIONS = Symbol('HAS_BASE_OPTIONS');

const URL_ERROR = 'Expected an HTTP or HTTPS request URL (<string|URL>)';
const FREEZED_OPTION_ERROR = 'Expected every values of `frozenOptions` option to be an Object property name (<string>)';
const BASE_URL_ERROR = 'Expected `baseUrl` option to be an HTTP or HTTPS URL to rebase all requests from it (<string|URL>)';
const HEADERS_ERROR = 'Expected `headers` option to be a Headers constructor argument (<object|Map|Array>';
const USER_AGENT_ERROR = 'Expected `userAgent` option to be a User-Agent <string>';
const METHOD_ERROR = 'Expected `method` option to be a request method (<string>), for exmaple \'post\' and \'HEAD\'';
const REDIRECT_ERROR = 'Expected `redirect` option to be a <string> one of \'error\', \'follow\' and \'manual\'';
const FOLLOW_ERROR = 'Expected `follow` option to be a positive safe integer or 0 (20 by default)';
const TIMEOUT_ERROR = 'Expected `timeout` option to be a positive safe integer or 0';
const SIZE_ERROR = 'Expected `size` option to be a positive safe integer or 0';
const CACHE_ERROR = 'Expected `cache` option to be a <string> one of \'default\', \'force-cache\', \'no-cache\', \'no-store\' and \'only-if-cached\'';
const MAX_SOCKETS_ERROR = 'Expected `maxSockets` option to be a positive safe integer or Infinity (15 by default)';

function toLowerCase(str) {
	return str.toLowerCase();
}

function quote(str) {
	return `\`${str}\``;
}

function headersToObject(headers) {
	if (headers[Symbol.iterator]) {
		return lowercaseKeys(fromEntries(headers));
	}

	return lowercaseKeys(headers);
}

function createMessageLine(msg, err, index) {
	return `${msg}\n  ${(index + 1)}. ${err.message}`;
}

function getUrlValidationError(message, url, baseUrl) {
	if (typeof url !== 'string' && !(url instanceof URL)) {
		return new TypeError(`${message}, but got ${inspectWithKind(url)}.`);
	}

	if (!baseUrl && typeof url === 'string') {
		if (url.length === 0) {
			return new RangeError(`${message}, but got '' (empty string).`);
		}

		if (url.trim().length === 0) {
			return new URIError(`${message}, but got a whitespace-only string ${inspect(url)}.`);
		}
	}

	try {
		decodeURI(url);
	} catch {
		const rfc3986Error = new URIError(`${message}, but received an RFC 3986 incompatible URI ${
			inspect(url.toString())
		}. In short, RFC 3986 says that a URI must be a UTF-8 sequence. https://tools.ietf.org/html/rfc3986`);
		rfc3986Error.code = 'ERR_INVALID_URI';

		throw rfc3986Error;
	}

	try {
		url = new URL(url, baseUrl);
	} catch (err) {
		err.message = `${message}, but got an invalid URL ${inspect(url)}.`;
		return err;
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		const error = new RangeError(`${message}, but got an non-HTTP(S) URL ${inspect(url.toString())}.`);
		error.code = 'ERR_INVALID_URL_SCHEME';

		return error;
	}

	return null;
}

function validateOptions(options, isBaseOptions, frozenInBase, additionalOptionValidatorsInBase) {
	if (options !== null && typeof options !== 'object') {
		const error = new TypeError(`Expected options object (<Object>), but got ${
			inspectWithKind(options)
		}.`);
		error.code = 'ERR_INVALID_ARG_TYPE';

		throw error;
	}

	const errors = [];
	const additionalErrors = [];
	const {
		cacheManager,
		counter,
		frozenOptions,
		additionalOptionValidators,
		urlModifier,
		baseUrl,
		resolveUnsuccessfulResponse,
		userAgent,
		method,
		headers,
		redirect,
		follow,
		timeout,
		size,
		cache,
		maxSockets
	} = options;

	if (isBaseOptions) {
		if (additionalOptionValidators !== undefined) {
			if (!Array.isArray(additionalOptionValidators)) {
				errors.push(new TypeError(`Expected \`additionalOptionValidators\` option to be <Array<Function>>, but got a non-array value ${
					inspectWithKind(additionalOptionValidators)
				}.`));
			} else {
				for (const [index, additionalOptionValidator] of additionalOptionValidators.entries()) {
					if (typeof additionalOptionValidator !== 'function') {
						errors.push(new TypeError(`Expected every item of \`additionalOptionValidators\` option to be a function, but included a non-function value ${
							inspectWithKind(additionalOptionValidator)
						} at ${index}.`));

						continue;
					}
				}
			}
		}
	} else {
		for (const disallowedOption of CREATE_METHOD_SPECIFIC_OPTIONS) {
			if (options[disallowedOption] === undefined) {
				continue;
			}

			errors.push(new TypeError(`\`${disallowedOption}\` option is only available on creating new instances and cannot be used in each function call, but got a value ${
				inspectWithKind(options[disallowedOption])
			}.`));
		}
	}

	if (frozenInBase) {
		const invalidOptions = [];

		for (const frozenOption of frozenInBase) {
			if (!Object.getOwnPropertyDescriptor(options, frozenOption)) {
				continue;
			}

			invalidOptions.push(inspect(frozenOption));
		}

		if (invalidOptions.length !== 0) {
			const error = new TypeError(`${
				invalidOptions.length === 1 ?
					`${invalidOptions[0]} option is not configurable, but it was` :
					`${arrayToSentence(invalidOptions)} options are not configurable, but they were`
			} tried to be configured.`);
			error.code = 'ERR_OPTION_UNCONFIGURABLE';

			throw error;
		}
	} else if (frozenOptions !== undefined) {
		if (!isSet(frozenOptions)) {
			errors.push(new TypeError(`Expected \`frozenOptions\` option to be <Set<string>>, but got a non-Set value ${
				inspectWithKind(frozenOptions)
			}.`));
		} else if (frozenOptions.size === 0) {
			errors.push(new RangeError('Expected `frozenOptions` option to have at least 1 value, but got an empty Set.'));
		} else {
			for (const frozenOption of frozenOptions) {
				if (typeof frozenOption !== 'string') {
					errors.push(new Error(`${FREEZED_OPTION_ERROR}, but got a non-string value ${inspectWithKind(frozenOption)}.`));
				} else if (frozenOption.length === 0) {
					errors.push(new RangeError(`${FREEZED_OPTION_ERROR}, but got '' (empty string).`));
				} else if (frozenOption.trim().length === 0) {
					errors.push(new RangeError(`${FREEZED_OPTION_ERROR}, but got a whitespace-only string ${inspect(frozenOption)}.`));
				} else if (frozenOption.match(/\W/u) !== null) {
					errors.push(new Error(`${FREEZED_OPTION_ERROR}, but got an unknown option name ${inspectWithKind(frozenOption)}.`));
				}
			}
		}
	}

	if (additionalOptionValidatorsInBase) {
		for (const additionalOptionValidatorInBase of additionalOptionValidatorsInBase) {
			try {
				additionalOptionValidatorInBase(options);
			} catch (err) {
				additionalErrors.push(err);
			}
		}
	}

	for (const key of Object.keys(options)) {
		const correctOption = POSSIBLE_TYPOS.get(key.toLowerCase());

		if (correctOption) {
			errors.push(new Error(`\`${key}\` option doesn't exist. Probably it's a typo for \`${correctOption}\`.`));
		}
	}

	if (cacheManager !== undefined) {
		errors.push(new TypeError(`\`cacheManager\` option defaults to ${inspect(CACHE_DIR)} and cannot be configured, but got a value ${inspect(cacheManager)}.`));
	}

	if (counter !== undefined) {
		errors.push(new TypeError(`\`counter\` option is not supported, but got a value ${inspect(counter)}.`));
	}

	if (baseUrl !== undefined) {
		const baseUrlError = getUrlValidationError(BASE_URL_ERROR, baseUrl);

		if (baseUrlError) {
			errors.push(baseUrlError);
		} else {
			const {hash, pathname, search} = new URL(baseUrl);

			if (!pathname.endsWith('/')) {
				const base = 'https://example.org';

				errors.push(new Error(`Expect the path portion of \`baseUrl\` option to be empty or end with a slash, for example ${base} and ${base}/abc/ are allowed but https://example.org/abc is not, but got ${
					inspect(baseUrl.toString())
				} whose path portion is ${inspect(pathname)}.`));
			}

			for (const [propName, val] of new Map([
				['hash', hash],
				['search parameter', search]
			])) {
				if (!val) {
					continue;
				}

				errors.push(new Error(`Expect \`baseUrl\` option to have no ${propName}, but got ${
					inspect(baseUrl.toString())
				} whose ${propName} is ${inspect(val)}.`));
			}
		}
	}

	if (urlModifier !== undefined && typeof urlModifier !== 'function') {
		errors.push(new TypeError(`Expected \`urlModifier\` option to be <Function>, but got a non-function value ${
			inspectWithKind(urlModifier)
		}.`));
	}

	if (resolveUnsuccessfulResponse !== undefined && typeof resolveUnsuccessfulResponse !== 'boolean') {
		errors.push(new TypeError(`Expected \`resolveUnsuccessfulResponse\` option to be boolean, but got a non-boolean value ${
			inspectWithKind(resolveUnsuccessfulResponse)
		}.`));
	}

	if (userAgent !== undefined) {
		if (typeof userAgent !== 'string') {
			errors.push(new TypeError(`${USER_AGENT_ERROR}, but got a non-string value ${inspectWithKind(userAgent)}.`));
		} else if (userAgent.length === 0) {
			errors.push(new RangeError(`${USER_AGENT_ERROR}, but got '' (empty string).`));
		} else if (userAgent.trim().length === 0) {
			errors.push(new RangeError(`${USER_AGENT_ERROR}, but got a whitespace-only string ${inspect(userAgent)}.`));
		}
	}

	if (method !== undefined) {
		if (typeof method !== 'string') {
			errors.push(new TypeError(`${METHOD_ERROR}, but got a non-string value ${inspectWithKind(method)}.`));
		} else if (method.length === 0) {
			errors.push(new RangeError(`${METHOD_ERROR}, but got '' (empty string).`));
		} else if (!METHODS.includes(method.toUpperCase())) {
			errors.push(new RangeError(`${METHOD_ERROR}, but got an unknown method ${inspect(method)}.`));
		}
	}

	if (headers !== undefined) {
		const fields = [];

		if (headers === null || typeof headers !== 'object') {
			errors.push(new TypeError(`${HEADERS_ERROR}, but got ${inspectWithKind(headers)}.`));
		} else if (typeof headers[Symbol.iterator] === 'function') {
			for (const pair of headers) {
				if (pair === null || typeof pair !== 'object') {
					errors.push(new TypeError(`${HEADERS_ERROR}, but got ${
						inspectWithKind(headers)
					}, one of whose header pairs is a non-object value ${inspectWithKind(pair)}.`));

					continue;
				}

				if (typeof pair[Symbol.iterator] !== 'function') {
					errors.push(new TypeError(`${HEADERS_ERROR}, but got ${
						inspectWithKind(headers)
					}, one of whose header pairs ${inspectWithKind(pair)} is not iterable.`));

					continue;
				}

				const pairArray = [...pair];

				if (pairArray.length !== 2) {
					errors.push(new TypeError(`${HEADERS_ERROR}, but got ${
						inspectWithKind(headers)
					}, one of whose header pair ${inspectWithKind(pair)} is not a one-to-one name/value tuple.`));

					continue;
				}

				fields.push(pairArray[0]);
			}
		} else if (headers[Symbol.iterator] !== undefined) {
			errors.push(new TypeError(`${HEADERS_ERROR}, but got ${
				inspectWithKind(headers)
			} whose \`Symbol.iterator\` property is defined but not a function.`));
		} else {
			fields.push(...Object.keys(headers));
		}

		const lowerCaseFields = fields.map(toLowerCase);

		while (fields.length !== 0) {
			const field = fields.shift();
			const lowerCaseField = lowerCaseFields.shift();

			const caseInsensitivelyMatchedIndexes = arrIndexesOf(lowerCaseFields, lowerCaseField);

			if (caseInsensitivelyMatchedIndexes.length === 0) {
				continue;
			}

			const matchedValues = caseInsensitivelyMatchedIndexes.map(index => {
				lowerCaseFields.splice(index, 1);
				return fields.splice(index, 1);
			});

			errors.push(new Error(`The headers contain practically duplicate fields ${
				arrayToSentence([field, ...matchedValues].map(quote))
			} as RFC 7230 says header fields are case insensitive (https://tools.ietf.org/html/rfc7230#section-3.2). If the \`${
				lowerCaseField
			}\` field needs to have multiple values, list them as a commma-separated value in a single \`${
				lowerCaseField
			}\` field and remove the others.`));
		}
	}

	if (redirect !== undefined) {
		if (typeof redirect !== 'string') {
			errors.push(new TypeError(`${REDIRECT_ERROR}, but got a non-string value ${inspectWithKind(redirect)}.`));
		} else if (redirect.length === 0) {
			errors.push(new RangeError(`${REDIRECT_ERROR}, but got '' (empty string).`));
		} else if (!REDIRECT_OPTIONS.has(redirect)) {
			errors.push(new RangeError(`${REDIRECT_ERROR}, but got an invalid value ${inspect(redirect)}.`));
		}
	}

	if (cache !== undefined) {
		if (typeof cache !== 'string') {
			errors.push(new TypeError(`${CACHE_ERROR}, but got a non-string value ${inspectWithKind(cache)}.`));
		} else if (!CACHE_OPTIONS.has(cache)) {
			errors.push(new RangeError(`${CACHE_ERROR}, but got none of them ${inspect(cache)}.`));
		}
	}

	const integerOptionErrorValueMap = new Map([
		[FOLLOW_ERROR, follow],
		[TIMEOUT_ERROR, timeout],
		[SIZE_ERROR, size],
		[MAX_SOCKETS_ERROR, maxSockets]
	]);

	if (maxSockets === 0) {
		errors.push(new RangeError(`${MAX_SOCKETS_ERROR}, but got ${inspect(maxSockets)}.`));
		integerOptionErrorValueMap.delete(MAX_SOCKETS_ERROR);
	} else if (maxSockets === Infinity) {
		integerOptionErrorValueMap.delete(MAX_SOCKETS_ERROR);
	}

	for (const [spec, integerOption] of integerOptionErrorValueMap) {
		if (integerOption === undefined) {
			continue;
		}

		if (typeof integerOption !== 'number') {
			errors.push(new TypeError(`${spec}, but got a non-number value ${inspectWithKind(integerOption)}.`));
			continue;
		}

		if (isNaN(integerOption)) {
			errors.push(new RangeError(`${spec}, but got NaN.`));
			continue;
		}

		if (integerOption === Infinity) {
			errors.push(new RangeError(`${spec}, but got Infinity.`));
			continue;
		}

		if (integerOption < 0) {
			errors.push(new RangeError(`${spec}, but got a negative number ${inspect(integerOption)}.`));
			continue;
		}

		if (integerOption > 2147483646) {
			errors.push(new RangeError(`${spec}, but got a too large number.`));
			continue;
		}

		if (!Number.isInteger(integerOption)) {
			errors.push(new RangeError(`${spec}, but got a non-integer number ${integerOption}.`));
			continue;
		}
	}

	errors.push(...additionalErrors);

	if (errors.length === 0) {
		return;
	}

	if (errors.length === 1) {
		const [error] = errors;
		error.code = 'ERR_INVALID_OPT_VALUE';

		throw error;
	}

	const error = new Error(errors.reduce(
		createMessageLine,
		`${errors.length} errors found in the options object:`
	));
	error.code = 'ERR_INVALID_OPT_VALUE';

	throw error;
}

let promiseCache;
let makeFetchHappen;

async function request(...args) {
	const argLen = args.length;

	if (
		argLen !== 1 &&
		argLen !== 2 &&
		args[2] !== HAS_BASE_OPTIONS
	) {
		throw new RangeError(`Expected 1 or 2 arguments (<string>[, <Object>]), but got ${
			argLen === 0 ? 'no' : argLen
		} arguments.`);
	}

	const [originalUrl, options = {}, _, baseOptions = {}] = args;

	if (argLen === 2) {
		validateOptions(options);
	}

	const mergedOptions = {...baseOptions, ...options};
	const userAgentFromUserAgentOption = options.userAgent || baseOptions.userAgent;

	mergedOptions.headers = {
		...baseOptions.headers,
		...options.headers ? headersToObject(options.headers) : null,
		...userAgentFromUserAgentOption ? {'user-agent': userAgentFromUserAgentOption} : null
	};

	const url = mergedOptions.urlModifier ? mergedOptions.urlModifier(originalUrl) : originalUrl;
	const urlError = getUrlValidationError(URL_ERROR, url, mergedOptions.baseUrl);

	if (urlError) {
		throw urlError;
	}

	const mergedUrl = new URL(url, mergedOptions.baseUrl);
	const proxyRelatedEnvs = new Map();

	for (const [key, value] of Object.entries(process.env)) {
		const lowerCaseKey = key.toLowerCase();

		if (!PROXY_RELATED_ENVS.has(lowerCaseKey)) {
			continue;
		}

		proxyRelatedEnvs.set(lowerCaseKey, value);
	}

	if (mergedOptions.noProxy === undefined && !proxyRelatedEnvs.has('no_proxy') && process.env.npm_config_no_proxy) {
		mergedOptions.noProxy = process.env.npm_config_no_proxy;
	}

	if (mergedOptions.proxy === undefined) {
		if (mergedUrl.protocol === 'https:') {
			if (
				// https://github.com/zkat/make-fetch-happen/blob/v4.0.1/agent.js#L119
				!proxyRelatedEnvs.has('https_proxy') &&
				process.env.npm_config_https_proxy
			) {
				mergedOptions.proxy = process.env.npm_config_https_proxy;
			}
		} else if (
			// https://github.com/zkat/make-fetch-happen/blob/v4.0.1/agent.js#L121
			!proxyRelatedEnvs.has('https_proxy') &&
			!proxyRelatedEnvs.has('http_proxy') &&
			!proxyRelatedEnvs.has('proxy') &&
			process.env.npm_config_proxy
		) {
			mergedOptions.proxy = process.env.npm_config_proxy;
		}
	}

	const mergedUrlStr = mergedUrl.toString();
	const response = await makeFetchHappen(mergedUrlStr, mergedOptions);

	if (response.body && response.body.constructor.prototype[Symbol.asyncIterator] === undefined) {
		response.body.constructor.prototype[Symbol.asyncIterator] = readableAsyncIterator;
	}

	const {status, statusText, url: finalUrl} = response;
	const method = mergedOptions.method ? mergedOptions.method.toUpperCase() : 'GET';

	if (
		!mergedOptions.resolveUnsuccessfulResponse &&
		status !== NOT_MODIFIED &&
		(status < 200 || (mergedOptions.redirect === 'manual' ? 399 : 299) < status)
	) {
		const httpError = new Error(`${status} (${statusText}) responded by a ${method} request to ${mergedUrlStr}${
			mergedUrlStr !== finalUrl ? ` that is finally redirected to ${finalUrl}` : ''
		}.`);
		Object.defineProperty(httpError, 'response', {value: response});

		throw httpError;
	}

	return response;
}

async function getCoreFn() {
	try {
		makeFetchHappen = (await loadFromCwdOrNpm('make-fetch-happen')).defaults({
			maxSockets: 0,
			cacheManager: CACHE_DIR
		});
	} catch (err) {
		return err;
	}

	return request;
}

async function prepare() {
	if (promiseCache) {
		return promiseCache;
	}

	const [result] = await Promise.all([
		getCoreFn(),
		rejectUnsatisfiedNpmVersion(MINIMUM_REQUIRED_NPM_VERSION)
	]);

	if (isNativeError(result)) {
		throw result;
	}

	promiseCache = result;
	return result;
}

module.exports = async function wiseFetch(...args) {
	return (await prepare())(...args);
};

module.exports.create = function create(...defaultsArgs) {
	const argLen = defaultsArgs.length;

	if (defaultsArgs[1] !== HAS_BASE_OPTIONS && argLen !== 1) {
		throw new RangeError(`Expected 1 argument (<Object>), but got ${argLen || 'no'} arguments.`);
	}

	validateOptions(defaultsArgs[0], true);

	const baseOptions = {...defaultsArgs[2] || {}, ...defaultsArgs[0]};

	if (baseOptions.headers) {
		baseOptions.headers = headersToObject(baseOptions.headers);
	}

	async function wiseFetch(...args) {
		if (args.length === 1) {
			return module.exports(args[0], wiseFetch.options, HAS_BASE_OPTIONS);
		}

		if (args.length === 2) {
			validateOptions(args[1], false, wiseFetch.options.frozenOptions, wiseFetch.options.additionalOptionValidators);
			return module.exports(...args, HAS_BASE_OPTIONS, wiseFetch.options);
		}

		return module.exports(...args);
	}

	wiseFetch.options = baseOptions;
	wiseFetch.create = function recreate(...args) {
		return module.exports.create(...args, HAS_BASE_OPTIONS, wiseFetch.options);
	};

	return wiseFetch;
};

Object.defineProperties(module.exports, {
	CACHE_DIR: {
		value: CACHE_DIR,
		enumerable: true
	},
	MINIMUM_REQUIRED_NPM_VERSION: {
		value: MINIMUM_REQUIRED_NPM_VERSION,
		enumerable: true
	}
});
