import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../content/hook-main.js', import.meta.url), 'utf8');

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Run hook-main.js in a fake MAIN world with a fake fetch and XMLHttpRequest. */
function load(responder) {
  const messages = [];
  const fetchCalls = [];
  class FakeXHR {
    constructor() {
      this.listeners = {};
      this.responseType = '';
      this.status = 0;
      this.responseText = '';
      this.responseURL = '';
    }
    open(method, url) {
      this.openedUrl = url;
    }
    send(body) {
      this.sentBody = body;
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    fire(type) {
      for (const fn of this.listeners[type] || []) fn.call(this);
    }
  }
  const protoOpen = FakeXHR.prototype.open;
  const protoSend = FakeXHR.prototype.send;
  const origFetch = function (input, init) {
    fetchCalls.push({ input, init, self: this });
    return responder ? responder(input, init) : undefined;
  };
  const sandbox = {
    URL,
    URLSearchParams,
    location: { href: 'https://library.tiktok.com/ads' },
    XMLHttpRequest: FakeXHR,
    fetch: origFetch,
    postMessage(m) {
      messages.push(m);
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { sandbox, messages, fetchCalls, FakeXHR, protoOpen, protoSend, origFetch };
}

test('XMLHttpRequest.prototype.send is never replaced', () => {
  const { FakeXHR, protoSend, protoOpen } = load();
  assert.equal(FakeXHR.prototype.send, protoSend);
  assert.notEqual(FakeXHR.prototype.open, protoOpen);
});

test('non-matching XHR runs the untouched prototype send', () => {
  const { FakeXHR, protoSend, messages } = load();
  const xhr = new FakeXHR();
  xhr.open('POST', 'https://mcs.tiktokw.com/v1/list');
  assert.equal(Object.prototype.hasOwnProperty.call(xhr, 'send'), false);
  assert.equal(xhr.send, protoSend);
  xhr.send('x');
  assert.equal(xhr.sentBody, 'x');
  assert.equal(messages.length, 0);
});

test('matching XHR gets a per-instance send and posts the response', () => {
  const { FakeXHR, protoSend, messages } = load();
  const xhr = new FakeXHR();
  xhr.open('POST', '/api/v1/search?region=DE');
  assert.equal(Object.prototype.hasOwnProperty.call(xhr, 'send'), true);
  assert.notEqual(xhr.send, protoSend);
  xhr.send('{"query":"nike"}');
  assert.equal(xhr.sentBody, '{"query":"nike"}');
  xhr.status = 200;
  xhr.responseText = '{"data":[]}';
  xhr.fire('load');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].__superpixel, true);
  assert.equal(messages[0].url, 'https://library.tiktok.com/api/v1/search?region=DE');
  assert.equal(messages[0].body, '{"data":[]}');
  assert.equal(messages[0].reqBody, '{"query":"nike"}');

  // Re-opened for an unrelated url: back to the prototype send, no capture.
  xhr.open('GET', 'https://www.tiktok.com/other');
  assert.equal(Object.prototype.hasOwnProperty.call(xhr, 'send'), false);
  xhr.fire('load');
  assert.equal(messages.length, 1);
});

test('mon.tiktokv.com is skipped entirely (XHR and fetch)', async () => {
  const sentinel = { sentinel: true };
  const { sandbox, FakeXHR, fetchCalls, messages } = load(() => sentinel);
  const xhr = new FakeXHR();
  xhr.open('POST', 'https://mon.tiktokv.com/monitor_browser/collect/batch/api/v1/x');
  assert.equal(Object.prototype.hasOwnProperty.call(xhr, 'send'), false);
  const r = sandbox.fetch('https://mon-va.tiktokv.com/api/v1/report');
  assert.equal(r, sentinel);
  assert.equal(fetchCalls.length, 1);
  await tick();
  assert.equal(messages.length, 0);
});

test('fetch passes non-matching calls straight to the original fetch', () => {
  const sentinel = { sentinel: true };
  const { sandbox, fetchCalls } = load(() => sentinel);
  const init = { method: 'POST' };
  const r = sandbox.fetch('https://www.facebook.com/ajax/bz', init);
  assert.equal(r, sentinel);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].input, 'https://www.facebook.com/ajax/bz');
  assert.equal(fetchCalls[0].init, init);
  assert.equal(fetchCalls[0].self, sandbox);
  // The wrapper decides before anything else: its first statement returns the original call.
  assert.match(SRC, /var wrappedFetch = function \(input, init\) \{\s*if \(!matches\(fetchUrl\(input\)\)\) return origFetch\.apply\(this, arguments\);/);
});

test('fetch observes matching calls and returns the original promise', async () => {
  const res = { status: 200, clone: () => ({ text: async () => '{"data":{"ad_library_main":{}}}' }) };
  const p = Promise.resolve(res);
  const { sandbox, messages } = load(() => p);
  const out = sandbox.fetch('https://www.facebook.com/api/graphql/', { method: 'POST', body: 'fb_api_req_friendly_name=AdLibrarySearchPaginationQuery' });
  assert.equal(out, p);
  await tick();
  await tick();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].url, 'https://www.facebook.com/api/graphql/');
  assert.equal(messages[0].status, 200);
  assert.match(messages[0].reqBody, /AdLibrarySearchPaginationQuery/);
});

/** Run hook-main.js in a minimal window with a counting close(); `top` decides top frame or not. */
function loadWithClose(isTop) {
  const state = { closed: 0, messages: [] };
  const origClose = function () {
    state.closed++;
  };
  const sandbox = {
    URL,
    location: { href: 'https://library.tiktok.com/ads' },
    close: origClose,
    postMessage(m) {
      state.messages.push(m);
    },
  };
  sandbox.window = sandbox;
  sandbox.top = isTop ? sandbox : {};
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { sandbox, state, origClose };
}

test('window.close in the top frame does not close and posts the caller stack', () => {
  const { sandbox, state } = loadWithClose(true);
  vm.runInContext('(function pageCloser() { window.close(); })()', sandbox);
  assert.equal(state.closed, 0);
  assert.equal(state.messages.length, 1);
  const m = state.messages[0];
  assert.equal(m.__superpixel, true);
  assert.equal(m.url, 'superpixel:window-close');
  assert.equal(m.status, 0);
  assert.match(m.body, /pageCloser/);
  assert.ok(m.body.length <= 1500);
});

test('window.close in a subframe is left untouched', () => {
  const { sandbox, origClose } = loadWithClose(false);
  assert.equal(sandbox.close, origClose);
});
