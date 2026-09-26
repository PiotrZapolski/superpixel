// Superpixel network hook. Runs in the MAIN world at document_start on the Meta and TikTok ad
// libraries, BEFORE page scripts, so the app's own fetch/XHR references are the wrapped ones.
// It only observes: the original response is always returned untouched, and every step is in
// try/catch so the page can never break because of this script.
//
// Requests we do not care about must never run through our code: Chrome attributes errors to the
// top script frame on the stack, so TikTok's own CSP violations and failed monitoring calls
// (mon.tiktokv.com) showed up as Superpixel errors when XHR.prototype.send was wrapped. Hence:
// - fetch: non-matching urls go straight to the original fetch as the first statement;
// - XHR: only `open` is wrapped (to decide); a matching request gets a per-instance `send`,
//   XMLHttpRequest.prototype.send is never replaced.
(function () {
  'use strict';
  try {
    if (window.__superpixelHooked) return;
    Object.defineProperty(window, '__superpixelHooked', { value: true, enumerable: false });
  } catch (e) {
    return;
  }

  var MAX_BODY = 3 * 1024 * 1024;
  var MAX_REQ_BODY = 4096;
  var SKIP_HOST_RE = /^(?:https?:)?\/\/mon[a-z0-9-]*\.tiktokv\.com(?:[:/?#]|$)/i;

  function matches(url) {
    if (typeof url !== 'string' || !url) return false;
    if (SKIP_HOST_RE.test(url)) return false;
    return url.indexOf('/api/graphql/') !== -1 || url.indexOf('/api/v1/') !== -1;
  }

  function fetchUrl(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      if (input && typeof input.href === 'string') return input.href;
    } catch (e) {
      // ignore
    }
    return '';
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch (e) {
      return String(url);
    }
  }

  function bodyToString(b) {
    try {
      if (b == null) return '';
      if (typeof b === 'string') return b.slice(0, MAX_REQ_BODY);
      if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString().slice(0, MAX_REQ_BODY);
      if (typeof FormData !== 'undefined' && b instanceof FormData) {
        var parts = [];
        b.forEach(function (v, k) {
          if (typeof v === 'string') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        });
        return parts.join('&').slice(0, MAX_REQ_BODY);
      }
    } catch (e) {
      // ignore
    }
    return '';
  }

  function post(url, status, body, reqBody) {
    try {
      window.postMessage(
        {
          __superpixel: true,
          url: absolute(url),
          status: status,
          body: typeof body === 'string' ? body.slice(0, MAX_BODY) : '',
          reqBody: typeof reqBody === 'string' ? reqBody.slice(0, MAX_REQ_BODY) : '',
        },
        '*'
      );
    } catch (e) {
      // ignore
    }
  }

  // fetch
  try {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      var requestBody = function (input, init) {
        try {
          if (init && init.body != null) return Promise.resolve(bodyToString(init.body));
          if (typeof Request !== 'undefined' && input instanceof Request && !input.bodyUsed) {
            // Clone BEFORE the original fetch consumes the body.
            return input
              .clone()
              .text()
              .then(function (t) {
                return t.slice(0, MAX_REQ_BODY);
              })
              .catch(function () {
                return '';
              });
          }
        } catch (e) {
          // ignore
        }
        return Promise.resolve('');
      };
      var observeFetch = function (url, reqBodyPromise, p) {
        try {
          p.then(
            function (res) {
              try {
                var clone = res.clone();
                Promise.all([clone.text(), reqBodyPromise])
                  .then(function (vals) {
                    post(url, res.status, vals[0], vals[1]);
                  })
                  .catch(function () {});
              } catch (e) {
                // ignore
              }
            },
            function () {}
          );
        } catch (e) {
          // ignore
        }
      };
      var wrappedFetch = function (input, init) {
        if (!matches(fetchUrl(input))) return origFetch.apply(this, arguments);
        var url = fetchUrl(input);
        var reqBodyPromise = requestBody(input, init);
        var p = origFetch.apply(this, arguments);
        observeFetch(url, reqBodyPromise, p);
        return p;
      };
      window.fetch = wrappedFetch;
    }
  } catch (e) {
    // ignore
  }

  // XMLHttpRequest: wrap open only; matching requests get a per-instance send.
  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origOpen = XHR.prototype.open;
      var protoSend = XHR.prototype.send;
      var instanceSend = function (body) {
        try {
          if (this.__superpixelUrl) this.__superpixelReqBody = bodyToString(body);
        } catch (e) {
          // ignore
        }
        return protoSend.apply(this, arguments);
      };
      var onLoad = function () {
        try {
          var xhr = this;
          var url = xhr.__superpixelUrl;
          if (!url) return;
          var rt = xhr.responseType;
          if (rt !== '' && rt !== 'text') return;
          post(xhr.responseURL || url, xhr.status, xhr.responseText, xhr.__superpixelReqBody || '');
        } catch (e) {
          // ignore
        }
      };
      XHR.prototype.open = function (method, url) {
        try {
          var u = typeof url === 'string' ? url : url && typeof url.href === 'string' ? url.href : '';
          if (matches(u)) {
            this.__superpixelUrl = u;
            if (this.send !== instanceSend) this.send = instanceSend;
            if (!this.__superpixelListening) {
              this.__superpixelListening = true;
              this.addEventListener('load', onLoad);
            }
          } else if (this.__superpixelUrl) {
            // Re-opened for another url: fall back to the untouched prototype send.
            this.__superpixelUrl = '';
            if (Object.prototype.hasOwnProperty.call(this, 'send')) delete this.send;
          }
        } catch (e) {
          // ignore
        }
        return origOpen.apply(this, arguments);
      };
    }
  } catch (e) {
    // ignore
  }
})();
