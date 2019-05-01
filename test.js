'use strict';

const {createServer} = require('http');
const {inspect, promisify} = require('util');
const {randomBytes} = require('crypto');
const {resolve} = require('path');
const {stat} = require('fs').promises;

const AbortController = require('abort-controller');
const brokenNpmPath = require('broken-npm-path');
const clearModules = require('clear-module').all;
const noop = require('lodash/noop');
const test = require('tape');
const wiseFetch = require('.');

const randomStr = randomBytes(20).toString('hex');
const server = createServer((request, response) => {
	const {pathname} = new URL(request.url, 'http://localhost:3018/');
	if (pathname === '/') {
		response.writeHead(200, {
			'content-type': 'text/plain',
			'content-length': '2'
		});
		response.write('Hi');
	} else if (pathname.startsWith('/json')) {
		response.writeHead(200, {
			'content-type': 'application/json',
			'cache-control': 'max-age=5'
		});
		response.write(`["${request.headers.foo}","${request.headers['user-agent']}"]`);
	} else {
		response.writeHead(404, {'content-type': 'text/plain'});
		response.write('[wise-fetch], Not found...');
	}

	response.end(() => request.destroy());
});

test('wiseFetch()', async t => {
	const abortController = new AbortController();

	process.env.npm_config_proxy = 'http://localhost:3018/';
	await promisify(server.listen.bind(server))(3018);
	await Promise.all([
		(async () => {
			t.equal(
				await (await wiseFetch('http://localhost:3018/')).text(),
				'Hi',
				'should make an HTTP request.'
			);
		})(),
		(async () => {
			try {
				await wiseFetch(`https://${randomStr}${randomStr}${randomStr}.org`);
				t.fail('Unexpectedly succeeded.');
			} catch ({code}) {
				t.equal(
					code,
					'ENOTFOUND',
					'should support HTTPS.'
				);
			}
		})(),
		(async () => {
			const response = await wiseFetch('http://localhost:3018/json', {
				headers: {fOo: randomStr},
				userAgent: 'U',
				maxSockets: Infinity,
				redirect: 'manual'
			});

			t.notOk(
				response.headers.has('x-local-cache'),
				'should not include `x-local-cache` to a fresh response header.'
			);

			t.deepEqual(
				await response.json(),
				[randomStr, 'U'],
				'should support node-fetch and make-fetch-happen options.'
			);
		})(),
		(async () => {
			try {
				const response = await wiseFetch('http://localhost:3018/', {signal: abortController.signal});
				setImmediate(() => abortController.abort());
				await response.text();
				t.fail('Unexpectedly succeeded.');
			} catch ({message}) {
				t.ok(
					message.endsWith('The GET request to http://localhost:3018/ was aborted.'),
					'should be abortable via AbortController#abort().'
				);
			}
		})()
	]);

	try {
		await (await wiseFetch('http://localhost:3018/', {signal: abortController.signal})).text();
		t.fail('Unexpectedly succeeded.');
	} catch ({message}) {
		t.ok(
			message.endsWith('The GET request to http://localhost:3018/ was aborted.'),
			'should abort the request immediately when the AbortSignal is already aborted.'
		);
	}

	delete process.env.npm_config_proxy;

	process.env.proxy = 'http://localhost:3018';
	process.env.npm_config_no_proxy = 'http://n/o/n/e';

	t.ok(
		(await wiseFetch('http://localhost:3018/json', {
			headers: [['foo', randomStr]]
		})).headers.has('x-local-cache'),
		'should include `x-local-cache` to a fresh response header.'
	);

	delete process.env.proxy;

	await Promise.all([
		(async () => {
			try {
				await wiseFetch(`http://${randomStr}.org/1`, {proxy: 'http://localhost:3018/'});
			} catch ({message, response}) {
				t.equal(
					message,
					`404 (Not Found) responded by a GET request to http://${randomStr}.org/1.`,
					'should be rejected by default when the response is not successful.'
				);

				t.equal(
					response.statusText,
					'Not Found',
					'should include a response to the error when the response is not successful.'
				);
			}
		})(),
		(async () => {
			try {
				await wiseFetch(`https://www.github.com/${randomStr}`);
			} catch ({message, response}) {
				t.equal(
					message,
					`404 (Not Found) responded by a GET request to https://www.github.com/${
						randomStr
					} that is finally redirected to https://github.com/${randomStr}.`,
					'should include final URL to the error message when the response is not successful.'
				);

				t.equal(
					response.statusText,
					'Not Found',
					'should include a response to the error when the response is not successful.'
				);
			}
		})(),
		(async () => {
			for await (const chunk of (await wiseFetch(`http://${randomStr}.org/2`, {
				proxy: 'http://localhost:3018',
				resolveUnsuccessfulResponse: true
			})).body) {
				t.ok(
					chunk.equals(Buffer.from('[wise-fetch], Not found...')),
					'should get a response with an async-iterable body.'
				);
			}
		})()
	]);

	t.end();
});

test('wiseFetch.create()', async t => {
	const fail = t.fail.bind(t, 'Unexpectedly succeeded.');
	process.env.npm_config_https_proxy = 'https://example.org';

	try {
		await wiseFetch.create({timeout: 2})('https://github.com');
		fail();
	} catch ({code}) {
		t.equal(
			code,
			'ETIMEOUT',
			'should create a function with the given defaults.'
		);
	}

	const options = {
		timeout: 2,
		headers: {},
		method: 'pOsT',
		frozenOptions: new Set(['redirect'])
	};

	try {
		await wiseFetch.create(options)('https://github.com', {});
	} catch {} finally {
		t.deepEqual(
			options,
			{
				timeout: 2,
				headers: {},
				method: 'pOsT',
				frozenOptions: new Set(['redirect'])
			},
			'should keep the base options immutable.'
		);
	}

	delete process.env.npm_config_https_proxy;

	const newWiseFetch = wiseFetch.create({
		headers: new Map([['foo', 'this header should be overridden']]),
		userAgent: 'A',
		method: 'Get',
		baseUrl: 'http://localhost:3018/json/',
		redirect: 'error',
		cache: 'no-cache',
		maxSockets: 1
	});

	t.ok((await (await newWiseFetch('', {
		headers: {
			foo: 'successfully overridden'
		}
	})).buffer()).equals(Buffer.from('["successfully overridden","A"]')), 'should merge headers.');

	await promisify(server.close.bind(server))();

	try {
		wiseFetch.create({}).create({redirect: 'mammal'});
		fail();
	} catch (err) {
		t.equal(
			err.toString(),
			'RangeError: Expected `redirect` option to be a <string> one of \'error\', \'follow\' and \'manual\', but got an invalid value \'mammal\'.',
			'should ensure create functions also have `create` method.'
		);
	}

	try {
		wiseFetch.create({}).create({redirect: 'mammal'});
		fail();
	} catch (err) {
		t.equal(
			err.toString(),
			'RangeError: Expected `redirect` option to be a <string> one of \'error\', \'follow\' and \'manual\', but got an invalid value \'mammal\'.',
			'should ensure create functions also have `create` method.'
		);
	}

	try {
		await wiseFetch.create({frozenOptions: new Set(['method'])})('ddd', {method: 'post'});
		fail();
	} catch (err) {
		t.equal(
			err.toString(),
			'TypeError: \'method\' option is not configurable, but it was tried to be configured.',
			'should freeze an option when `frozenOptions` option is provided.'
		);
	}

	try {
		await wiseFetch.create({frozenOptions: new Set(['redirect', 'timeout'])})('ddd', {
			redirect: 'error',
			timeout: 1
		});
		fail();
	} catch (err) {
		t.equal(
			err.toString(),
			'TypeError: \'redirect\' and \'timeout\' options are not configurable, but they were tried to be configured.',
			'should freeze options when `frozenOptions` option is provided.'
		);
	}

	try {
		await wiseFetch.create({
			additionalOptionValidators: [
				noop,
				({timeout}) => {
					if (timeout !== 123) {
						throw new Error('timeout must be 123');
					}
				}
			]
		})('https://example.org', {timeout: 100});
		fail();
	} catch (err) {
		t.equal(
			err.toString(),
			'Error: timeout must be 123',
			'should apply additional option validation when `additionalOptionValidators` option is provided.'
		);
	}

	try {
		await wiseFetch.create({
			urlModifier(url) {
				if (url.protocol !== 'https:') {
					throw new Error('protocol must be HTTPS');
				}

				return url;
			}
		})(new URL('http://example.org'));
		fail();
	} catch (err) {
		t.equal(
			err.toString(),
			'Error: protocol must be HTTPS',
			'should apply URL modification to the original URL when `urlModifier` option is provided.'
		);
	}

	try {
		await newWiseFetch('', {}, {});
		fail();
	} catch (err) {
		t.equal(
			err.toString(),
			'RangeError: Expected 1 or 2 arguments (<string>[, <Object>]), but got 3 arguments.',
			'should pass all arguments to the instance.'
		);
	}

	t.end();
});

test('wiseFetch() argument validation', async t => {
	async function getError(...args) {
		try {
			return await wiseFetch(...args);
		} catch (err) {
			return err;
		}
	}

	t.equal(
		(await getError([-0])).toString(),
		'TypeError: Expected an HTTP or HTTPS request URL (<string|URL>), but got [ -0 ] (array).',
		'should fail when it takes a non-string URL.'
	);

	t.equal(
		(await getError('')).toString(),
		'RangeError: Expected an HTTP or HTTPS request URL (<string|URL>), but got \'\' (empty string).',
		'should fail when it takes an empty string as a URL.'
	);

	t.equal(
		(await getError('\t\n')).toString(),
		'URIError: Expected an HTTP or HTTPS request URL (<string|URL>), but got a whitespace-only string \'\\t\\n\'.',
		'should fail when it takes a whitespace-only string as a URL.'
	);

	t.ok(
		(await getError('https://localhost:3000/%%')).message.includes(' received an RFC 3986 incompatible URI \'https://localhost:3000/%%\''),
		'should fail when it takes a non-UTF-8 URL.'
	);

	t.equal(
		(await getError('not a URL')).code,
		'ERR_INVALID_URL',
		'should fail when it takes a non-URL string.'
	);

	t.equal(
		(await getError('https://localhost:3000/', true)).toString(),
		'TypeError: Expected options object (<Object>), but got true (boolean).',
		'should fail when the second argument is not an Object.'
	);

	t.equal(
		(await getError('https://localhost:3000/', {
			cacheManager: new Uint8Array(),
			counter: 8,
			resolveUnsuccessfulResponse: new Int32Array(),
			baseUrl: 'ftp://a/',
			signal: {aborted: 1},
			headers: Symbol('?'),
			redirect: Buffer.from('1'),
			cache: new Set([null]),
			follow: '123',
			timeout: NaN,
			size: Infinity,
			maxSockets: -1,
			compression: true
		})).toString(),
		`Error: 13 errors found in the options object:
  1. \`compression\` option doesn't exist. Probably it's a typo for \`compress\`.
  2. \`cacheManager\` option defaults to ${inspect(wiseFetch.CACHE_DIR)} and cannot be configured, but got a value Uint8Array [].
  3. \`counter\` option is not supported, but got a value 8.
  4. Expected \`baseUrl\` option to be an HTTP or HTTPS URL to rebase all requests from it (<string|URL>), but got an non-HTTP(S) URL 'ftp://a/'.
  5. Expected \`resolveUnsuccessfulResponse\` option to be boolean, but got a non-boolean value Int32Array [].
  6. Expected \`signal\` option to be an AbortSignal, but got { aborted: 1 } (object).
  7. Expected \`headers\` option to be a Headers constructor argument (<object|Map|Array>, but got Symbol(?).
  8. Expected \`redirect\` option to be a <string> one of 'error', 'follow' and 'manual', but got a non-string value <Buffer 31>.
  9. Expected \`cache\` option to be a <string> one of 'default', 'force-cache', 'no-cache', 'no-store' and 'only-if-cached', but got a non-string value Set { null }.
  10. Expected \`follow\` option to be a positive safe integer or 0 (20 by default), but got a non-number value '123' (string).
  11. Expected \`timeout\` option to be a positive safe integer or 0, but got NaN.
  12. Expected \`size\` option to be a positive safe integer or 0, but got Infinity.
  13. Expected \`maxSockets\` option to be a positive safe integer or Infinity (15 by default), but got a negative number -1.`,
		'should display all errors when the options object has multiple errors.'
	);

	t.equal(
		(await getError('https://localhost:3000/', {frozenOptions: new Set(['headers'])})).toString(),
		'TypeError: `frozenOptions` option is only available on creating new instances ' +
		'and cannot be used in each function call, but got a value Set { \'headers\' }.',
		'should fail when it takes `frozenOptions` option.'
	);

	t.equal(
		(await getError('https://localhost:3000/', {method: new Uint32Array()})).toString(),
		'TypeError: Expected `method` option to be a request method (<string>), ' +
		'for exmaple \'post\' and \'HEAD\', but got a non-string value Uint32Array [].',
		'should fail when it takes non-string `method` option.'
	);

	t.equal(
		(await getError('https://localhost:3000/', {method: ''})).toString(),
		'RangeError: Expected `method` option to be a request method (<string>), ' +
		'for exmaple \'post\' and \'HEAD\', but got \'\' (empty string).',
		'should fail when it takes empty-string `method` option.'
	);

	t.equal(
		(await getError('https://localhost:3000/', {method: 'GOT'})).toString(),
		'RangeError: Expected `method` option to be a request method (<string>), ' +
		'for exmaple \'post\' and \'HEAD\', but got an unknown method \'GOT\'.',
		'should fail when it takes unknown `method` option.'
	);

	t.equal(
		(await getError('https://localhost:3000/', {userAgent: Math.floor})).toString(),
		'TypeError: Expected `userAgent` option to be a User-Agent <string>, but got a non-string value [Function: floor].',
		'should fail when it takes a non-string `userAgent` option.'
	);

	t.equal(
		(await getError('https://localhost:3000/', {userAgent: ''})).toString(),
		'RangeError: Expected `userAgent` option to be a User-Agent <string>, but got \'\' (empty string).',
		'should fail when it takes an empty `userAgent` option.'
	);

	t.equal(
		(await getError('https://localhost:3000/', {userAgent: '\t\r'})).toString(),
		'RangeError: Expected `userAgent` option to be a User-Agent <string>, but got a whitespace-only string \'\\t\\r\'.',
		'should fail when it takes a whitespace-only `userAgent` option.'
	);

	t.equal(
		(await getError()).toString(),
		'RangeError: Expected 1 or 2 arguments (<string>[, <Object>]), but got no arguments.',
		'should fail when it takes no arguments.'
	);

	t.equal(
		(await getError('https://example.org', {}, {})).toString(),
		'RangeError: Expected 1 or 2 arguments (<string>[, <Object>]), but got 3 arguments.',
		'should fail when it takes too many arguments.'
	);

	t.end();
});

test('wiseFetch.create() argument validation', async t => {
	const fail = t.fail.bind(t, 'Unexpectedly succeeded.');
	const baseUrl = 'https://example.org/path?x=y#fragment';
	const headers = {[Symbol.iterator]: new Uint16Array()};

	try {
		wiseFetch.create({headers});
		fail();
	} catch (err) {
		t.equal(
			err.toString(),
			'TypeError: Expected `headers` option to be a Headers constructor argument ' +
			'(<object|Map|Array>, but got { [Symbol(Symbol.iterator)]: Uint16Array [] } (object) ' +
			'whose `Symbol.iterator` property is defined but not a function.',
			'should fail when it takes an invalid option.'
		);
	}

	try {
		wiseFetch.create({
			baseUrl,
			headers: new Set([noop, [0, 1, 2], ['f-i-e-l-d', 'val0'], ['f-I-e-L-d', 'val1'], {}]),
			redirect: '',
			cache: 'noo-cache',
			maxSockets: 0,
			size: Number.MAX_SAFE_INTEGER + 1,
			timeout: 0.1
		});

		fail();
	} catch (err) {
		t.equal(
			err.toString(),
			`Error: 12 errors found in the options object:
  1. Expect the path portion of \`baseUrl\` option to be empty or end with a slash, for example https://example.org and https://example.org/abc/ are allowed but https://example.org/abc is not, but got '${baseUrl}' whose path portion is '/path'.
  2. Expect \`baseUrl\` option to have no hash, but got '${baseUrl}' whose hash is '#fragment'.
  3. Expect \`baseUrl\` option to have no search parameter, but got '${baseUrl}' whose search parameter is '?x=y'.
  4. Expected \`headers\` option to be a Headers constructor argument (<object|Map|Array>, but got Set { [Function: noop], [ 0, 1, 2 ], [ 'f-i-e-l-d', 'val0' ], [ 'f-I-e-L-d', 'val1' ], {} }, one of whose header pairs is a non-object value [Function: noop].
  5. Expected \`headers\` option to be a Headers constructor argument (<object|Map|Array>, but got Set { [Function: noop], [ 0, 1, 2 ], [ 'f-i-e-l-d', 'val0' ], [ 'f-I-e-L-d', 'val1' ], {} }, one of whose header pair [ 0, 1, 2 ] (array) is not a one-to-one name/value tuple.
  6. Expected \`headers\` option to be a Headers constructor argument (<object|Map|Array>, but got Set { [Function: noop], [ 0, 1, 2 ], [ 'f-i-e-l-d', 'val0' ], [ 'f-I-e-L-d', 'val1' ], {} }, one of whose header pairs {} (object) is not iterable.
  7. The headers contain practically duplicate fields \`f-i-e-l-d\` and \`f-I-e-L-d\` as RFC 7230 says header fields are case insensitive (https://tools.ietf.org/html/rfc7230#section-3.2). If the \`f-i-e-l-d\` field needs to have multiple values, list them as a commma-separated value in a single \`f-i-e-l-d\` field and remove the others.
  8. Expected \`redirect\` option to be a <string> one of 'error', 'follow' and 'manual', but got '' (empty string).
  9. Expected \`cache\` option to be a <string> one of 'default', 'force-cache', 'no-cache', 'no-store' and 'only-if-cached', but got none of them 'noo-cache'.
  10. Expected \`maxSockets\` option to be a positive safe integer or Infinity (15 by default), but got 0.
  11. Expected \`timeout\` option to be a positive safe integer or 0, but got a non-integer number 0.1.
  12. Expected \`size\` option to be a positive safe integer or 0, but got a too large number.`,
			'should fail when it takes multiple invalid options.'
		);
	}

	t.throws(
		() => wiseFetch.create({frozenOptions: []}),
		/^TypeError.*Expected `frozenOptions` option to be <Set<string>>, but got a non-Set value \[\] \(array\)\./u,
		'should fail when `frozenOptions` option is not a Set.'
	);

	t.throws(
		() => wiseFetch.create({frozenOptions: new Set()}),
		/^RangeError.*Expected `frozenOptions` option to have at least 1 value, but got an empty Set\./u,
		'should fail when `frozenOptions` option is an empty Set.'
	);

	try {
		wiseFetch.create({frozenOptions: new Set([Infinity, '', ' ', 'a^'])});
		fail();
	} catch (err) {
		t.equal(
			err.toString(),
			`Error: 4 errors found in the options object:
  1. Expected every values of \`frozenOptions\` option to be an Object property name (<string>), but got a non-string value Infinity (number).
  2. Expected every values of \`frozenOptions\` option to be an Object property name (<string>), but got '' (empty string).
  3. Expected every values of \`frozenOptions\` option to be an Object property name (<string>), but got a whitespace-only string ' '.
  4. Expected every values of \`frozenOptions\` option to be an Object property name (<string>), but got an unknown option name 'a^' (string).`,
			'should fail when `frozenOptions` option includes invalid values.'
		);
	}

	t.throws(
		() => wiseFetch.create({urlModifier: Buffer.from('&')}),
		/^TypeError.*Expected `urlModifier` option to be <Function>, but got a non-function value <Buffer 26>\./u,
		'should fail when `urlModifier` option is not a function.'
	);

	t.throws(
		() => wiseFetch.create({additionalOptionValidators: 0.1}),
		/^TypeError: Expected `additionalOptionValidators` option to be <Array<Function>>, but got a non-array value 0\.1 \(number\)\./u,
		'should fail when `additionalOptionValidators` option is not an array.'
	);

	t.throws(
		() => wiseFetch.create({additionalOptionValidators: [noop, '0', noop]}),
		/^TypeError.*Expected every item of `additionalOptionValidators` option to be a function, but included a non-function value '0' \(string\) at 1\./u,
		'should fail when `additionalOptionValidators` option contains a non-function value.'
	);

	t.throws(
		() => wiseFetch.create(),
		/^RangeError.*Expected 1 argument \(<Object>\), but got no arguments\./u,
		'should fail when it takes no arguments.'
	);

	t.throws(
		() => wiseFetch.create({}, {}),
		/^RangeError.*Expected 1 argument \(<Object>\), but got 2 arguments\./u,
		'should fail when it takes too many arguments.'
	);

	t.end();
});

test('wiseFetch.CACHE_DIR', async t => {
	t.ok(
		(await stat(wiseFetch.CACHE_DIR)).isDirectory(),
		'should indicate a cache directory path.'
	);

	t.end();
});

test('wiseFetch() with a broken npm CLI', async t => {
	process.env.PATH = resolve('/none/exists');
	process.env.npm_execpath = brokenNpmPath;

	clearModules();

	try {
		await require('.')('https://example.org');
		t.fail('Unexpectedly succeeded.');
	} catch ({code}) {
		t.equal(code, 'MODULE_NOT_FOUND', 'should fail.');
	}

	t.end();
});
