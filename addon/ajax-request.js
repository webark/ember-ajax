import Ember from 'ember';
import {
  AjaxError,
  UnauthorizedError,
  InvalidError,
  ForbiddenError,
  BadRequestError,
  NotFoundError,
  ServerError,
  isUnauthorizedError,
  isForbiddenError,
  isInvalidError,
  isBadRequestError,
  isNotFoundError,
  isServerError,
  isSuccess
} from './errors';
import parseResponseHeaders from './utils/parse-response-headers';
import { RequestURL } from './utils/url-helpers';

const {
  $,
  RSVP: { Promise },
  get,
  isPresent,
  run
} = Ember;

export default class AjaxRequest {

  request(url, options) {
    const hash = this.options(url, options);
    return new Promise((resolve, reject) => {
      this.raw(url, hash)
        .then(({ response }) => {
          resolve(response);
        })
        .catch(({ response }) => {
          reject(response);
        });
    }, `ember-ajax: ${hash.type} ${hash.url} response`);
  }

  raw(url, options) {
    const hash = this.options(url, options);
    const requestData = {
      type: hash.type,
      url: hash.url
    };
    return new Promise((resolve, reject) => {
      hash.success = (payload, textStatus, jqXHR) => {
        let response = this.handleResponse(
          jqXHR.status,
          parseResponseHeaders(jqXHR.getAllResponseHeaders()),
          payload,
          requestData
        );

        if (hash.dataType === 'jsonp') {
          $('body').trigger('ajaxComplete');
        }

        if (response instanceof AjaxError) {
          run.join(null, reject, { payload, textStatus, jqXHR, response });
        } else {
          run.join(null, resolve, { payload, textStatus, jqXHR, response });
        }
      };

      hash.error = (jqXHR, textStatus, errorThrown) => {
        const payload = this.parseErrorResponse(jqXHR.responseText) || errorThrown;
        const response = this.handleResponse(
           jqXHR.status,
           parseResponseHeaders(jqXHR.getAllResponseHeaders()),
           payload,
           requestData
        );

        if (hash.dataType === 'jsonp') {
          $('body').trigger('ajaxComplete');
        }

        run.join(null, reject, { payload, textStatus, jqXHR, errorThrown, response });
      };

      if (hash.dataType === 'jsonp') {
        $('body').trigger('ajaxSend');
      }

      $.ajax(hash);
    }, `ember-ajax: ${hash.type} ${hash.url}`);
  }

  /**
   * calls `request()` but forces `options.type` to `POST`
   * @public
   */
  post(url, options) {
    return this.request(url, this._addTypeToOptionsFor(options, 'POST'));
  }

  /**
   * calls `request()` but forces `options.type` to `PUT`
   * @public
   */
  put(url, options) {
    return this.request(url, this._addTypeToOptionsFor(options, 'PUT'));
  }

  /**
   * calls `request()` but forces `options.type` to `PATCH`
   * @public
   */
  patch(url, options) {
    return this.request(url, this._addTypeToOptionsFor(options, 'PATCH'));
  }

  /**
   * calls `request()` but forces `options.type` to `DELETE`
   * @public
   */
  del(url, options) {
    return this.request(url, this._addTypeToOptionsFor(options, 'DELETE'));
  }

  // forcibly manipulates the options hash to include the HTTP method on the type key
  _addTypeToOptionsFor(options, method) {
    options = options || {};
    options.type = method;
    return options;
  }

  /**
   * @method options
   * @private
   * @param {String} url
   * @param {Object} options
   * @return {Object}
   */
  options(url, options = {}) {
    options.url = this._buildURL(url, options);
    options.type = options.type || 'GET';
    options.dataType = options.dataType || 'json';
    options.context = this;

    if (this._shouldSendHeaders(options)) {
      const headers = get(this, 'headers');
      if (isPresent(headers)) {
        options.beforeSend = function(xhr) {
          Object.keys(headers).forEach((key) =>  xhr.setRequestHeader(key, headers[key]));
        };
      }
    }

    return options;
  }

  _buildURL(url, options) {
    const host = options.host || get(this, 'host');
    const namespace = get(this, 'namespace');
    const urlObject = new RequestURL(url);

    // If the URL passed is not relative, return the whole URL
    if (urlObject.isAbsolute) {
      return urlObject.href;
    }

    let _url = this._normalizePath(url);
    let _namespace = this._normalizePath(namespace);

    return [ host, _namespace, _url ].join('');
  }

  _normalizePath(path) {
    if (path) {
      // make sure path starts with `/`
      if (path.charAt(0) !== '/') {
        path = `/${path}`;
      }

      // remove end `/`
      if (path.charAt(path.length - 1) === '/') {
        path = path.slice(0, -1);
      }
    }
    return path;
  }

  /**
   * Takes an ajax response, and returns the json payload or an error.
   *
   * By default this hook just returns the json payload passed to it.
   * You might want to override it in two cases:
   *
   * 1. Your API might return useful results in the response headers.
   *    Response headers are passed in as the second argument.
   *
   * 2. Your API might return errors as successful responses with status code
   *    200 and an Errors text or object.
   *
   * @method handleResponse
   * @private
   * @param  {Number} status
   * @param  {Object} headers
   * @param  {Object} payload
   * @param  {Object} requestData the original request information
   * @return {Object | AjaxError} response
   */
  handleResponse(status, headers, payload, requestData) {
    payload = payload || {};
    const errors = this.normalizeErrorResponse(status, headers, payload);

    if (this.isSuccess(status, headers, payload)) {
      return payload;
    } else if (this.isUnauthorizedError(status, headers, payload)) {
      return new UnauthorizedError(errors);
    } else if (this.isForbiddenError(status, headers, payload)) {
      return new ForbiddenError(errors);
    } else if (this.isInvalidError(status, headers, payload)) {
      return new InvalidError(errors);
    } else if (this.isBadRequestError(status, headers, payload)) {
      return new BadRequestError(errors);
    } else if (this.isNotFoundError(status, headers, payload)) {
      return new NotFoundError(errors);
    } else if (this.isServerError(status, headers, payload)) {
      return new ServerError(errors);
    }

    const detailedMessage = this.generateDetailedMessage(status, headers, payload, requestData);
    return new AjaxError(errors, detailedMessage);
  }

  /**
   * Match the host to a provided array of host or regex's that can match a host
   *
   * @method matchHosts
   * @public
   * @param {String} host the host you are sending too
   * @param {RegExp | String} matcher a string or regex that you can match the host to.
   * @returns {Boolean} if the host passed the matcher
   */

  matchHosts(host, matcher) {
    if (matcher.constructor === RegExp) {
      return matcher.test(host);
    } else {
      return matcher === host;
    }
  }

  /**
   * Determine whether the headers should be added for this request
   *
   * This hook is used to help prevent sending headers to every host, regardless
   * of the destination, since this could be a security issue if authentication
   * tokens are accidentally leaked to third parties.
   *
   * To avoid that problem, subclasses should utilize the `headers` computed
   * property to prevent authentication from being sent to third parties, or
   * implement this hook for more fine-grain control over when headers are sent.
   *
   * By default, the headers are sent if the host of the request matches the
   * `host` property designated on the class.
   *
   * @method _shouldSendHeaders
   * @private
   * @property {Object} hash request options hash
   * @returns {Boolean} whether or not headers should be sent
   */
  _shouldSendHeaders({ url, host }) {
    url = url || '';
    host = host || get(this, 'host') || '';

    const urlObject = new RequestURL(url);
    const allowedHosts = get(this, 'allowedHosts') || Ember.A();
    // Add headers on relative URLs

    if (!urlObject.isAbsolute) {
      return true;
    } else if (allowedHosts.find((matcher) => this.matchHosts(urlObject.hostname, matcher))) {
      return true;
    }

    // Add headers on matching host
    const hostObject = new RequestURL(host);
    return urlObject.sameHost(hostObject);
  }

  /**
   * Generates a detailed ("friendly") error message, with plenty
   * of information for debugging (good luck!)
   * @method generateDetailedMessage
   * @private
   * @param  {Number} status
   * @param  {Object} headers
   * @param  {Object} payload
   * @param  {Object} requestData the original request information
   * @return {Object} request information
   */
  generateDetailedMessage(status, headers, payload, requestData) {
    let shortenedPayload;
    const payloadContentType = headers['Content-Type'] || 'Empty Content-Type';

    if (payloadContentType === 'text/html' && payload.length > 250) {
      shortenedPayload = '[Omitted Lengthy HTML]';
    } else {
      shortenedPayload = JSON.stringify(payload);
    }

    const requestDescription = `${requestData.type} ${requestData.url}`;
    const payloadDescription = `Payload (${payloadContentType})`;

    return [
      `Ember Data Request ${requestDescription} returned a ${status}`,
      payloadDescription,
      shortenedPayload
    ].join('\n');
  }

  /**
   * Default `handleResponse` implementation uses this hook to decide if the
   * response is a an authorized error.
   * @method isUnauthorizedError
   * @private
   * @param {Number} status
   * @param {Object} headers
   * @param {Object} payload
   * @return {Boolean}
   */
  isUnauthorizedError(status) {
    return isUnauthorizedError(status);
  }

  /**
   * Default `handleResponse` implementation uses this hook to decide if the
   * response is a forbidden error.
   * @method isForbiddenError
   * @private
   * @param {Number} status
   * @param {Object} headers
   * @param {Object} payload
   * @return {Boolean}
   */
  isForbiddenError(status) {
    return isForbiddenError(status);
  }

  /**
   * Default `handleResponse` implementation uses this hook to decide if the
   * response is a an invalid error.
   * @method isInvalidError
   * @private
   * @param {Number} status
   * @param {Object} headers
   * @param {Object} payload
   * @return {Boolean}
   */
  isInvalidError(status) {
    return isInvalidError(status);
  }

  /**
   * Default `handleResponse` implementation uses this hook to decide if the
   * response is a bad request error.
   * @method isBadRequestError
   * @private
   * @param {Number} status
   * @param {Object} headers
   * @param {Object} payload
   * @return {Boolean}
   */
  isBadRequestError(status) {
    return isBadRequestError(status);
  }

  /**
   * Default `handleResponse` implementation uses this hook to decide if the
   * response is a "not found" error.
   * @method isNotFoundError
   * @private
   * @param {Number} status
   * @param {Object} headers
   * @param {Object} payload
   * @return {Boolean}
   */
  isNotFoundError(status) {
    return isNotFoundError(status);
  }

  /**
   * Default `handleResponse` implementation uses this hook to decide if the
   * response is a server error.
   * @method isServerError
   * @private
   * @param {Number} status
   * @param {Object} headers
   * @param {Object} payload
   * @return {Boolean}
   */
  isServerError(status) {
    return isServerError(status);
  }

  /**
   * Default `handleResponse` implementation uses this hook to decide if the
   * response is a success.
   * @method isSuccess
   * @private
   * @param {Number} status
   * @param {Object} headers
   * @param {Object} payload
   * @return {Boolean}
   */
  isSuccess(status) {
    return isSuccess(status);
  }

  /**
   * @method parseErrorResponse
   * @private
   * @param {String} responseText
   * @return {Object}
   */
  parseErrorResponse(responseText) {
    let json = responseText;

    try {
      json = Ember.$.parseJSON(responseText);
    } catch (e) {}

    return json;
  }

  /**
   * @method normalizeErrorResponse
   * @private
   * @param  {Number} status
   * @param  {Object} headers
   * @param  {Object} payload
   * @return {Array} errors payload
   */
  normalizeErrorResponse(status, headers, payload) {
    if (payload && typeof payload === 'object' && payload.errors) {
      return payload.errors;
    } else {
      return [
        {
          status: `${status}`,
          title: 'The backend responded with an error',
          detail: payload
        }
      ];
    }
  }
}
