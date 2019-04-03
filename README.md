# wise-fetch

[![npm version](https://img.shields.io/npm/v/wise-fetch.svg)](https://www.npmjs.com/package/wise-fetch)
[![Build Status](https://travis-ci.com/shinnn/wise-fetch.svg?branch=master)](https://travis-ci.com/shinnn/wise-fetch)
[![Coverage Status](https://img.shields.io/coveralls/shinnn/wise-fetch.svg)](https://coveralls.io/github/shinnn/wise-fetch?branch=master)

Feature-rich [node-fetch](https://github.com/bitinn/node-fetch):

* Built-in [RFC compliant response cache](https://tools.ietf.org/html/rfc7234)
* Proxy support
* [Abortable](#optionssignal)
* [Base URL](#optionsbaseurl) support
* Automatic `Promise` rejection of unsuccessful responses by default
* Strict URL validation

```javascript
const wiseFetch = require('wise-fetch');

(async () => {
  const response = await wiseFetch('https://example.org');

  response.status; //=> 200
  response.headers.get('content-length'); //=> '606'

  const text = await response.text();
  //=> '<!doctype html>\n<html>\n<head>\n    <title>Example Domain</title> ...'
})();
```

## Installation

[Use](https://docs.npmjs.com/cli/install) [npm](https://docs.npmjs.com/about-npm/).

```
npm install wise-fetch
```

## API

```javascript
const wiseFetch = require('wise-fetch');
```

### wiseFetch(*url* [, *options*])

*url*: `string | URL` (HTTP or HTTPS URL)  
*options*: `Object`  
Return: [`Promise<Response>`](https://github.com/npm/node-fetch-npm/blob/v2.0.2/src/response.js#L21)

The API is very similar to the browser [`fetch`](https://developer.mozilla.org/docs/Web/API/WindowOrWorkerGlobalScope/fetch) API. It makes an HTTP or HTTPS request and returns a `Promise` of a [node-fetch-npm](https://github.com/npm/node-fetch-npm) [`Response`](https://github.com/npm/node-fetch-npm#class-response) object that works as if [DOM `Response`](https://developer.mozilla.org/docs/Web/API/Response) but has [additional](https://github.com/npm/node-fetch-npm#bodybuffer) [methods](https://github.com/npm/node-fetch-npm#bodytextconverted).

Unlike the `fetch` API, when the response is unsuccessful, that is, its status code is neither [`2xx`](https://tools.ietf.org/html/rfc7231#section-6.3), [`304`](https://tools.ietf.org/html/rfc7232#section-4.1), it will be rejected with an `Error` with a `response` property.

```javascript
(async () => {
  try {
    await wiseFetch('https://github.com/shinnn/it_does_not_exist');
  } catch (err) {
    err.message; //=> '404 (Not Found) responded by a GET request to https://github.com/shinnn/it_does_not_exist.'
    err.reponse.status; //=> 404
    await err.reponse.arrayBuffer(); //=> ArrayBuffer { ... } (the response body)
  }
})();
```

The response is cached to the [OS's default directory for temporary files](https://nodejs.org/api/os.html#os) in the [RFC 7234](https://tools.ietf.org/html/rfc7234) compliant way.

#### options

It supports the [all](https://github.com/zkat/make-fetch-happen#--node-fetch-options) [options](https://github.com/zkat/make-fetch-happen#--make-fetch-happen-options) that [make-fetch-happen](https://github.com/zkat/make-fetch-happen) can receives, except for `counter` and `cacheManager`.

When the program is running as an [npm script](https://docs.npmjs.com/misc/scripts), note that:

* `proxy` option defaults to the value of [`https-proxy`](https://docs.npmjs.com/misc/config#https-proxy) or [`proxy`](https://docs.npmjs.com/misc/config#proxy) npm config depending on the request protocol.
* `noProxy` option defaults to [`no-proxy`](https://docs.npmjs.com/misc/config#no-proxy) npm config.

Additionally, the following wise-fetch specific options are available.

##### options.baseUrl

Type: `string | URL`

Set the base URL to resolve against if the request URL is not absolute.

```javascript
(async () => {
  const response = await wiseFetch('~shinnn', {baseUrl: 'https://www.npmjs.com'});
  response.url; //=> 'https://www.npmjs.com/~shinnn'
})();
```

##### options.resolveUnsuccessfulResponse

Type: `boolean`  
Default: `false`

Return a resolved `Promise` even if the response is unsuccessful.

```javascript
(async () => {
  const response = await wiseFetch('https://github.com/shinnn/this_does_not_exist', {
    resolveUnsuccessfulResponse: true
  });

  response.statusText; //=> 'Not Found'
})();
```

##### options.signal

Type: [`AbortSignal`](https://developer.mozilla.org/docs/Web/API/AbortSignal)

Allow a user to abort the request via the corresponding [`AbortController`](https://developer.mozilla.org/docs/Web/API/AbortController/AbortController). Read [the article about abortable fetch](https://developers.google.com/web/updates/2017/09/abortable-fetch) for more details.

Currently Node.js doesn't support [`AbortController`](https://developer.mozilla.org/docs/Web/API/AbortController), so that users need to substitute [the userland implementation](https://github.com/mysticatea/abort-controller) for it.

```javascript
const AbortController = require('abort-controller');

const abortController = new AbortController();

(async () => {
  try {
    await wiseFetch('https://loclahost:5000/very_large_contents', {signal: abortController.signal});
  } catch (err) {
    err.message; //=> '... The GET request to https://loclahost:5000/very_large_contents was aborted'
  }
})();

setTimeout(() => abortController.abort(), 1000);
```

##### options.userAgent

Type: `string`

A shorthand for setting `user-agent` property of `headers` option.

### wiseFetch.create(*baseOptions*)

*baseOptions*: `Object`  
Return: `Function`

Create a new `wiseFetch` with the given defaults.

```javascript
const getGithubUserData = wiseFetch.create({
  baseUrl: 'https://api.github.com/users/',
  headers: {
    accept: 'application/vnd.github.v3+json',
    'user-agent': 'your app name'
  }
});

(async () => {
  await (await getGithubUserData('shinnn')).json();
  //=> {login: 'shinnn', id: 1131567, created_at: '2011-10-16T16:36:43Z', ...}
})();
```

`headers` of each function call will be merged to the base headers.

```javascript
const newWiseFetch = wiseFetch.create({
  headers: {
    'header-A': 'old value'
    'header-B': 'value'
  }
});

newWiseFetch('https://example.org', {
  headers: {
    'header-A': 'updated value',
    'header-C': 'new value'
  }
});
/* The final `header` is {
  'header-A': 'updated value',
  'header-B': 'value'
  'header-C': 'new value'
}. */
```

##### baseOptions.frozenOptions

Type: `Set<string>`

Make given options unconfigurable in each function call.

```javascript
const alwaysPost = wiseFetch.create({
  method: 'post',
  frozenOptions: new Set(['method'])
});

(async () => {
  try {
    await alwaysPost('https://example.org/api', {method: 'patch'});
  } catch (err) {
    err.toString();
    //=> TypeError: 'method' option is not configurable, but it was tried to be configured.
  }
})();
```

##### baseOptions.urlModifier

Type: `Function`

Update a request URL to the value this function returns, before applying [`baseUrl` option](#optionsbaseurl) to it.

This function receives the original URL and is expected to return a `string` or `URL`.

```javascript
(async () => {
  const response = await wiseFetch('https://example.org/', {urlModifier: url => `${url}?x=1`});
  response.url; //=> 'https://example.org/?x=1'
})();
```

##### baseOptions.additionalOptionValidators

Type: `Array<Function>`

An array of functions that performs additional option validation. Each functions receive an options `Object` and if at least one of then throws an error, `wiseFetch` will be rejected.

```javascript
const {username} = require('os').userInfo();

const forceYourUA = wiseFetch.create({
  additionalOptionValidators: [
    options => {
      if (options.userAgent && !options.userAgent.includes(username)) {
        throw new Error('user agent must include your name!');
      }
    }
  ]
});

forceYourUA('https://example.org', {userAgent: 'nothing'});
// rejected with an Error: 'user agent must include your name!'
```

### wiseFetch.ABORT_ERROR_CODE

Type: `integer`

An error [`code`](https://nodejs.org/api/errors.html#errors_error_code) that wiseFetch adds to the error when the request is [aborted](#optionssignal).

```javascript
(async () => {
  try {
    await wiseFetch('https://example.org/', {signal: someSignal});
  } catch (err) {
    if (err.code === wiseFetch.ABORT_ERROR_CODE) {
      console.log('Canceled');
    } else {
      throw err;
    }
  }
})();
```

### wiseFetch.CACHE_DIR

Type: `string`

A path of the directory where wise-fetch saves response cache.

Users can clear cache by deleting this directory.

## License

[ISC License](./LICENSE) © 2018 - 2019 Shinnosuke Watanabe
