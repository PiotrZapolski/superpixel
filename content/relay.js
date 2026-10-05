// Superpixel relay. Isolated world, document_start, on the Meta and TikTok ad libraries.
// Does nothing unless the service worker confirms this tab is a Superpixel capture tab, so normal
// browsing of these sites is unaffected.
(function () {
  'use strict';
  var MAX_TEXT = 100 * 1024;
  var MAX_HREFS = 2000;
  var MAX_BUFFER = 100;

  var confirmed = null; // null = unknown, true / false after the SW answers
  var buffer = [];
  var ssrSeen = new Set();

  function send(msg) {
    try {
      var p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {
      // extension reloaded or context invalidated
    }
  }

  function forwardCapture(d) {
    send({
      type: 'capture',
      url: typeof d.url === 'string' ? d.url : '',
      status: typeof d.status === 'number' ? d.status : 0,
      body: typeof d.body === 'string' ? d.body : '',
      reqBody: typeof d.reqBody === 'string' ? d.reqBody : '',
    });
  }

  function isFacebook() {
    try {
      return /(^|\.)facebook\.com$/.test(location.hostname);
    } catch (e) {
      return false;
    }
  }

  function sendSsrBlobs() {
    if (confirmed !== true || !isFacebook()) return;
    try {
      var nodes = document.querySelectorAll('script[type="application/json"]');
      for (var i = 0; i < nodes.length; i++) {
        var text = nodes[i].textContent || '';
        if (text.indexOf('collated_results') === -1 && text.indexOf('search_results_connection') === -1) continue;
        var key = text.length + ':' + text.slice(0, 200) + ':' + text.slice(-200);
        if (ssrSeen.has(key)) continue;
        ssrSeen.add(key);
        send({ type: 'capture', url: 'ssr', status: 200, body: text, reqBody: '' });
      }
    } catch (e) {
      // ignore
    }
  }

  function scheduleSsr() {
    if (!isFacebook()) return;
    var run = function () {
      sendSsrBlobs();
      setTimeout(sendSsrBlobs, 1500);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
  }

  window.addEventListener('message', function (event) {
    try {
      if (event.source !== window) return;
      var d = event.data;
      if (!d || d.__superpixel !== true) return;
      if (confirmed === false) return;
      if (confirmed === null) {
        if (buffer.length < MAX_BUFFER) buffer.push(d);
        return;
      }
      forwardCapture(d);
    } catch (e) {
      // ignore
    }
  });

  function onConfirmed(isCapture) {
    if (confirmed !== null) return;
    confirmed = !!isCapture;
    var pending = buffer;
    buffer = [];
    if (!confirmed) return;
    for (var i = 0; i < pending.length; i++) forwardCapture(pending[i]);
    scheduleSsr();
    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        try {
          if (!msg || typeof msg !== 'object') return false;
          if (msg.cmd === 'scroll') {
            var h = Math.max(
              document.body ? document.body.scrollHeight : 0,
              document.documentElement ? document.documentElement.scrollHeight : 0
            );
            window.scrollTo(0, h);
            sendResponse({ ok: true });
            return false;
          }
          if (msg.cmd === 'dom') {
            var text = '';
            try {
              text = (document.body && document.body.innerText) || '';
            } catch (e) {
              text = '';
            }
            var hrefs = [];
            var seen = new Set();
            try {
              var links = document.querySelectorAll('a[href]');
              for (var i = 0; i < links.length && hrefs.length < MAX_HREFS; i++) {
                var href = links[i].href; // absolute
                if (typeof href !== 'string' || !href || seen.has(href)) continue;
                seen.add(href);
                hrefs.push(href);
              }
            } catch (e) {
              // ignore
            }
            sendResponse({ text: text.slice(0, MAX_TEXT), hrefs: hrefs });
            return false;
          }
        } catch (e) {
          try {
            sendResponse({ text: '', hrefs: [] });
          } catch (e2) {
            // ignore
          }
        }
        return false;
      });
    } catch (e) {
      // ignore
    }
  }

  try {
    var p = chrome.runtime.sendMessage({ type: 'isCaptureTab' });
    if (p && typeof p.then === 'function') {
      p.then(
        function (res) {
          onConfirmed(!!(res && res.isCaptureTab));
        },
        function () {
          onConfirmed(false);
        }
      );
    } else {
      onConfirmed(false);
    }
  } catch (e) {
    onConfirmed(false);
  }
})();
