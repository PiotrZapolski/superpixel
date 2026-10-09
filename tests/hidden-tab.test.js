import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stackFrameUrls, isRealTabUrl, handleRuntimeMessage, WINDOW_CLOSE_URL } from '../background/hidden-tab.js';

const BLANK = 'chrome-extension://abcdef/blank.html';

test('isRealTabUrl: about:blank and our blank page are not real', () => {
  assert.equal(isRealTabUrl('', BLANK), false);
  assert.equal(isRealTabUrl('about:blank', BLANK), false);
  assert.equal(isRealTabUrl(BLANK, BLANK), false);
  assert.equal(isRealTabUrl(`${BLANK}?x=1`, BLANK), false);
  assert.equal(isRealTabUrl('https://library.tiktok.com/ads?region=DE', BLANK), true);
  assert.equal(isRealTabUrl('chrome-extension://abcdef/sidepanel/sidepanel.html', BLANK), true);
  assert.equal(isRealTabUrl('https://library.tiktok.com/ads', ''), true);
});

test('stackFrameUrls: page script urls without query strings, own frames skipped', () => {
  const stack = [
    'Error: window.close',
    '    at window.close (chrome-extension://abcdef/content/hook-main.js:120:19)',
    '    at e.t (https://lf16-cdn.example.com/obj/privacy/core.js?v=3&sig=secret:2:3456)',
    '    at https://lf16-cdn.example.com/obj/privacy/core.js?v=3&sig=secret:2:999',
    '    at n (https://library.tiktok.com/static/js/main.abc.js:1:200)',
    '    at r (https://library.tiktok.com/static/js/511.js#frag:1:5)',
  ].join('\n');
  const out = stackFrameUrls(stack);
  assert.equal(
    out,
    'https://lf16-cdn.example.com/obj/privacy/core.js:2:3456 < https://lf16-cdn.example.com/obj/privacy/core.js:2:999 < https://library.tiktok.com/static/js/main.abc.js:1:200'
  );
  assert.doesNotMatch(out, /secret|chrome-extension/);
  assert.equal(stackFrameUrls(''), '');
  assert.equal(stackFrameUrls(undefined), '');
});

test('handleRuntimeMessage: window-close from an unknown tab is not accepted', () => {
  const res = handleRuntimeMessage({ type: 'capture', url: WINDOW_CLOSE_URL, status: 0, body: 'x' }, { tab: { id: 99 } });
  assert.deepEqual(res, { ok: false });
  assert.deepEqual(handleRuntimeMessage({ type: 'isCaptureTab' }, { tab: { id: 99 } }), { isCaptureTab: false });
});
