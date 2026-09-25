// Superpixel network hook. Runs in the MAIN world at document_start on the Meta and TikTok ad
// libraries, BEFORE page scripts, so the app's own fetch/XHR references are the wrapped ones.
// It only observes: the original response is always returned untouched, and every step is in
// try/catch so the page can never break because of this script.
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

  function matches(url) {
    return typeof url === 'string' && (url.indexOf('/api/graphql/') !== -1 || url.indexOf('/api/v1/') !== -1);
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
      var wrappedFetch = function (input, init) {
        var url = '';
        var reqBodyPromise = null;
        try {
          url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
          if (matches(url)) {
            if (init && init.body != null) {
              reqBodyPromise = Promise.resolve(bodyToString(init.body));
            } else if (typeof Request !== 'undefined' && input instanceof Request && !input.bodyUsed) {
              // Clone BEFORE the original fetch consumes the body.
              reqBodyPromise = input
                .clone()
                .text()
                .then(function (t) {
                  return t.slice(0, MAX_REQ_BODY);
                })
                .catch(function () {
                  return '';
                });
            } else {
              reqBodyPromise = Promise.resolve('');
            }
          }
        } catch (e) {
          reqBodyPromise = null;
        }
        var p = origFetch.apply(this, arguments);
        if (reqBodyPromise) {
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
        }
        return p;
      };
      window.fetch = wrappedFetch;
    }
  } catch (e) {
    // ignore
  }

  // XMLHttpRequest
  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        try {
          this.__superpixelUrl = typeof url === 'string' ? url : url && url.href ? url.href : String(url);
        } catch (e) {
          // ignore
        }
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        try {
          var xhr = this;
          if (matches(xhr.__superpixelUrl)) {
            xhr.__superpixelReqBody = bodyToString(body);
            if (!xhr.__superpixelListening) {
              xhr.__superpixelListening = true;
              xhr.addEventListener('load', function () {
                try {
                  var url = xhr.__superpixelUrl;
                  if (!matches(url)) return;
                  var rt = xhr.responseType;
                  if (rt !== '' && rt !== 'text') return;
                  post(xhr.responseURL || url, xhr.status, xhr.responseText, xhr.__superpixelReqBody || '');
                } catch (e) {
                  // ignore
                }
              });
            }
          }
        } catch (e) {
          // ignore
        }
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) {
    // ignore
  }
})();
