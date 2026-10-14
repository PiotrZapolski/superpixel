// Offscreen document: loads one capture url at a time in an iframe on request of the service
// worker (background/frame-capture.js). Commands arrive over a port, never runtime.onMessage, so
// this page does not receive the relay's broadcast messages.
(function () {
  'use strict';
  var port = chrome.runtime.connect({ name: 'superpixel-offscreen' });
  var frame = null;
  var loadTimer = null;

  function reply(reqId, res) {
    try {
      port.postMessage({ reqId: reqId, res: res });
    } catch (e) {
      // service worker gone
    }
  }

  function removeFrame() {
    clearTimeout(loadTimer);
    loadTimer = null;
    if (!frame) return;
    try {
      frame.src = 'about:blank';
      frame.remove();
    } catch (e) {
      // ignore
    }
    frame = null;
  }

  function openFrame(reqId, url, name) {
    removeFrame();
    var f = document.createElement('iframe');
    var answered = false;
    var answer = function (loaded) {
      if (answered) return;
      answered = true;
      clearTimeout(loadTimer);
      loadTimer = null;
      reply(reqId, { loaded: loaded });
    };
    // window.name carries the capture token the relay in the frame sends to the service worker.
    f.name = name;
    // No allow-top-navigation: the page cannot navigate this document away.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    f.style.width = '1280px';
    f.style.height = '900px';
    f.style.border = '0';
    f.addEventListener('load', function () {
      if (f.src && f.src !== 'about:blank') answer(true);
    });
    loadTimer = setTimeout(function () {
      answer(false);
    }, 19000);
    frame = f;
    f.src = url;
    document.body.appendChild(f);
  }

  port.onMessage.addListener(function (msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.cmd === 'open' && typeof msg.url === 'string' && /^https:\/\/library\.tiktok\.com\//.test(msg.url)) {
      openFrame(msg.reqId, msg.url, String(msg.name || ''));
      return;
    }
    if (msg.cmd === 'open') {
      reply(msg.reqId, { loaded: false });
      return;
    }
    if (msg.cmd === 'close') {
      removeFrame();
      reply(msg.reqId, { ok: true });
    }
  });
})();
