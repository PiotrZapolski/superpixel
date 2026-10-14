// Superpixel relay. Isolated world, document_start, on the Meta and TikTok ad libraries.
// Does nothing unless the service worker confirms this tab (or offscreen capture frame, see
// background/frame-capture.js) is a Superpixel capture, so normal browsing of these sites is unaffected.
(function () {
  'use strict';
  var MAX_TEXT = 100 * 1024;
  var MAX_HREFS = 2000;
  var MAX_BUFFER = 100;

  var WINDOW_CLOSE_URL = 'superpixel:window-close';

  var FRAME_TOKEN_PREFIX = 'superpixel-frame-';

  var confirmed = null; // null = unknown, true / false after the SW answers
  var buffer = [];
  var ssrSeen = new Set();
  var closeRequested = false;

  // In the capture frame of background/frame-capture.js (an iframe in our offscreen document, no
  // tab) window.name carries the capture token. Read at document_start, before page scripts.
  var frameToken = '';
  try {
    if (window.top !== window && typeof window.name === 'string' && window.name.indexOf(FRAME_TOKEN_PREFIX) === 0) {
      frameToken = window.name;
    }
  } catch (e) {
    frameToken = '';
  }

  // The page called window.close(), which hook-main.js blocks. Outside capture tabs close the tab
  // as the page wanted: this isolated world's window.close is the untouched native one.
  function closeNatively() {
    try {
      window.close();
    } catch (e) {
      // ignore
    }
  }

  function send(msg) {
    if (frameToken) msg.frameToken = frameToken;
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
      if (d.url === WINDOW_CLOSE_URL) {
        if (confirmed === false) closeNatively();
        else if (confirmed === null) closeRequested = true;
      }
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
    if (!confirmed) {
      if (closeRequested) closeNatively();
      return;
    }
    for (var i = 0; i < pending.length; i++) forwardCapture(pending[i]);
    scheduleSsr();
    if (frameToken) {
      connectFramePort();
      return;
    }
    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        var res = runCommand(msg);
        if (res) sendResponse(res);
        return false;
      });
    } catch (e) {
      // ignore
    }
  }

  // Commands from the service worker: scroll to the bottom, or read page text + absolute hrefs.
  // Returns the response, or null for an unknown message.
  function runCommand(msg) {
    try {
      if (!msg || typeof msg !== 'object') return null;
      if (msg.cmd === 'scroll') {
        var h = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );
        window.scrollTo(0, h);
        return { ok: true };
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
        return { text: text.slice(0, MAX_TEXT), hrefs: hrefs };
      }
    } catch (e) {
      return { text: '', hrefs: [] };
    }
    return null;
  }

  // Capture frame: chrome.tabs.sendMessage cannot reach a frame without a tab, so the service
  // worker sends its commands over this port ({reqId, cmd} -> {reqId, res}).
  function connectFramePort() {
    try {
      var port = chrome.runtime.connect({ name: 'superpixel-frame' });
      port.onMessage.addListener(function (msg) {
        var res = runCommand(msg);
        if (!res || !msg || typeof msg.reqId !== 'number') return;
        try {
          port.postMessage({ reqId: msg.reqId, res: res });
        } catch (e) {
          // service worker gone
        }
      });
      port.postMessage({ type: 'hello', frameToken: frameToken });
    } catch (e) {
      // ignore
    }
  }

  try {
    var ask = { type: 'isCaptureTab' };
    if (frameToken) ask.frameToken = frameToken;
    var p = chrome.runtime.sendMessage(ask);
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
