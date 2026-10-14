import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleFrameMessage,
  isCaptureFrame,
  frameCapable,
  _setSession,
  FRAME_TOKEN_PREFIX,
  createFrameRouter,
  frameCaptureWorked,
  FRAME_MEMORY_KEY,
  FRAME_MEMORY_MS,
} from '../background/frame-capture.js';

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

function fakeMemory(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(k) { return data[k]; },
    async set(k, v) { data[k] = v; },
    async remove(k) { delete data[k]; },
  };
}

const TT = 'https://library.tiktok.com/ads?region=all&adv_name=x';
const NOW = Date.parse('2026-10-14T12:00:00.000Z');

function harness(memory, { tab = { error: 'tab_closed', payloads: [] }, frame = { error: '', payloads: [{ status: 200 }] } } = {}) {
  const logs = [];
  const calls = [];
  const route = createFrameRouter({ memory, now: () => NOW, log: (level, msg) => logs.push({ level, msg }) });
  const run = (url = TT) => route(
    url,
    async () => { calls.push('tab'); return tab; },
    async () => { calls.push('frame'); return frame; }
  );
  return { logs, calls, run };
}

test('frame router: tab_closed then a working frame capture is remembered for 7 days', async () => {
  const mem = fakeMemory();
  const h = harness(mem);
  const cap = await h.run();
  assert.equal(cap.payloads.length, 1);
  assert.deepEqual(h.calls, ['tab', 'frame']);
  assert.equal(mem.data[FRAME_MEMORY_KEY], NOW + FRAME_MEMORY_MS);
  assert.equal(h.logs.filter((l) => l.level === 'warn').length, 1);
  // Rest of this run: straight to the frame, no new warning.
  await h.run();
  assert.deepEqual(h.calls, ['tab', 'frame', 'frame']);
  assert.equal(h.logs.filter((l) => l.level === 'warn').length, 1);
});

test('frame router: tab_closed then a failing frame capture remembers nothing', async () => {
  const mem = fakeMemory();
  const h = harness(mem, { frame: { error: 'timeout', payloads: [] } });
  await h.run();
  assert.equal(mem.data[FRAME_MEMORY_KEY], undefined);
});

test('frame router: a working tab is used and nothing is remembered', async () => {
  const mem = fakeMemory();
  const h = harness(mem, { tab: { error: '', payloads: [{ status: 200 }] } });
  await h.run();
  assert.deepEqual(h.calls, ['tab']);
  assert.equal(mem.data[FRAME_MEMORY_KEY], undefined);
  assert.deepEqual(h.logs, []);
});

test('frame router: next run with the memory goes straight to the frame, one info line, no warning', async () => {
  const until = NOW + 3 * 24 * 60 * 60 * 1000;
  const mem = fakeMemory({ [FRAME_MEMORY_KEY]: until });
  const h = harness(mem, { frame: { error: '', text: 'Ad library results', hrefs: [] } });
  await h.run();
  await h.run();
  assert.deepEqual(h.calls, ['frame', 'frame']);
  assert.deepEqual(h.logs, [{
    level: 'info',
    msg: `Using the offscreen frame: capture tabs were closed by something in this browser (remembered until ${new Date(until).toISOString()})`,
  }]);
  assert.equal(mem.data[FRAME_MEMORY_KEY], until);
});

test('frame router: memory set but the frame fails clears it and retries through the tab', async () => {
  const mem = fakeMemory({ [FRAME_MEMORY_KEY]: NOW + 1000 });
  const h = harness(mem, { tab: { error: '', payloads: [{ status: 200 }] }, frame: { error: '', payloads: [] } });
  const cap = await h.run();
  assert.deepEqual(h.calls, ['frame', 'tab']);
  assert.equal(cap.payloads.length, 1);
  assert.equal(mem.data[FRAME_MEMORY_KEY], undefined);
  assert.ok(!h.logs.some((l) => l.level === 'warn'));
  // Healed: the next request of this run uses the tab.
  await h.run();
  assert.deepEqual(h.calls, ['frame', 'tab', 'tab']);
});

test('frame router: memory set and a user abort in the frame keeps it', async () => {
  const mem = fakeMemory({ [FRAME_MEMORY_KEY]: NOW + 1000 });
  const h = harness(mem, { frame: { error: 'aborted', payloads: [] } });
  await h.run();
  assert.deepEqual(h.calls, ['frame']);
  assert.equal(mem.data[FRAME_MEMORY_KEY], NOW + 1000);
});

test('frame router: an expired memory is ignored and other hosts never use the frame', async () => {
  const mem = fakeMemory({ [FRAME_MEMORY_KEY]: NOW - 1 });
  const h = harness(mem, { tab: { error: '', payloads: [{ status: 200 }] } });
  await h.run();
  await h.run('https://www.facebook.com/ads/library/?q=x');
  assert.deepEqual(h.calls, ['tab', 'tab']);
  assert.deepEqual(h.logs, []);
});

test('frame router: works without any memory (Node, no chrome)', async () => {
  const h = harness(undefined);
  await h.run();
  await h.run();
  assert.deepEqual(h.calls, ['tab', 'frame', 'frame']);
});

test('frameCaptureWorked: payloads or DOM text without error', () => {
  assert.equal(frameCaptureWorked({ error: '', payloads: [{}] }), true);
  assert.equal(frameCaptureWorked({ error: '', text: 'x', hrefs: [] }), true);
  assert.equal(frameCaptureWorked({ error: '', payloads: [] }), false);
  assert.equal(frameCaptureWorked({ error: 'no_dom', text: 'x' }), false);
  assert.equal(frameCaptureWorked(null), false);
});
