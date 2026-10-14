import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleFrameMessage, isCaptureFrame, frameCapable, _setSession, FRAME_TOKEN_PREFIX } from '../background/frame-capture.js';

const TOKEN = `${FRAME_TOKEN_PREFIX}abc123`;
const FRAME_SENDER = { url: 'https://library.tiktok.com/ads?region=all&adv_name=x', frameId: 3, documentId: 'D1' };

function session() {
  return { token: TOKEN, payloads: [], lastAt: 0, closed: false, port: null, documentId: '' };
}

test('frame gate: only the running capture frame is a capture', () => {
  _setSession(session());
  try {
    assert.deepEqual(handleFrameMessage({ type: 'isCaptureTab', frameToken: TOKEN }, FRAME_SENDER), { isCaptureTab: true });
    // A TikTok iframe inside some website tab: has a tab, never handled here.
    assert.equal(handleFrameMessage({ type: 'isCaptureTab', frameToken: TOKEN }, { ...FRAME_SENDER, tab: { id: 5 } }), undefined);
    assert.equal(isCaptureFrame({ type: 'isCaptureTab', frameToken: TOKEN }, { ...FRAME_SENDER, tab: { id: 5 } }), false);
    // Wrong or missing token, wrong host.
    assert.deepEqual(handleFrameMessage({ type: 'isCaptureTab', frameToken: `${FRAME_TOKEN_PREFIX}other` }, FRAME_SENDER), { isCaptureTab: false });
    assert.deepEqual(handleFrameMessage({ type: 'isCaptureTab' }, FRAME_SENDER), { isCaptureTab: false });
    assert.deepEqual(
      handleFrameMessage({ type: 'isCaptureTab', frameToken: TOKEN }, { ...FRAME_SENDER, url: 'https://evil.example/library.tiktok.com/' }),
      { isCaptureTab: false }
    );
  } finally {
    _setSession(null);
  }
});

test('frame gate: nothing is a capture without a running session', () => {
  _setSession(null);
  assert.deepEqual(handleFrameMessage({ type: 'isCaptureTab', frameToken: TOKEN }, FRAME_SENDER), { isCaptureTab: false });
  assert.deepEqual(handleFrameMessage({ type: 'capture', frameToken: TOKEN, url: 'u', body: 'b' }, FRAME_SENDER), { ok: false });
  const closed = session();
  closed.closed = true;
  _setSession(closed);
  assert.deepEqual(handleFrameMessage({ type: 'isCaptureTab', frameToken: TOKEN }, FRAME_SENDER), { isCaptureTab: false });
  _setSession(null);
});

test('frame capture: payloads of the running frame are recorded', () => {
  const s = session();
  _setSession(s);
  try {
    const res = handleFrameMessage(
      { type: 'capture', frameToken: TOKEN, url: 'https://library.tiktok.com/api/v1/search?x=1', status: 200, body: '{"data":[]}', reqBody: '' },
      FRAME_SENDER
    );
    assert.deepEqual(res, { ok: true });
    assert.equal(s.payloads.length, 1);
    assert.equal(s.payloads[0].status, 200);
    assert.ok(s.lastAt > 0);
    assert.deepEqual(handleFrameMessage({ type: 'capture', frameToken: 'nope', url: 'x' }, FRAME_SENDER), { ok: false });
    assert.equal(s.payloads.length, 1);
    // Unrelated messages are left to hidden-tab.js.
    assert.equal(handleFrameMessage({ type: 'other' }, FRAME_SENDER), undefined);
  } finally {
    _setSession(null);
  }
});

test('frameCapable: TikTok Ad Library only', () => {
  assert.equal(frameCapable('https://library.tiktok.com/ads?region=all'), true);
  assert.equal(frameCapable('https://library.tiktok.com/ads/detail/?ad_id=1'), true);
  assert.equal(frameCapable('https://www.facebook.com/ads/library/?q=x'), false);
  assert.equal(frameCapable('not a url'), false);
});
