import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRemoteLog,
  isShipped,
  worthSending,
  chunkEntries,
  getInstallId,
  ENDPOINT,
  INGEST_KEY,
  MAX_BATCH,
  SRC,
} from '../background/remote-log.js';
import { log, onEntry, clearLog } from '../background/log.js';
import { DEFAULT_SETTINGS } from '../background/settings.js';

const entry = (level, src, msg) => ({ t: '2026-10-05T10:00:00.000Z', level, src, msg });

function fakeFetch(status = 204) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { status, ok: status >= 200 && status < 300 };
  };
  fn.calls = calls;
  return fn;
}

function make(overrides = {}) {
  const logged = [];
  const rl = createRemoteLog({
    fetch: fakeFetch(),
    getConsent: () => true,
    getInstallId: () => 'install-1',
    version: '9.9.9',
    log: (level, src, msg) => logged.push({ level, src, msg }),
    ...overrides,
  });
  return { rl, logged };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('remote log: entry selection keeps warn/error, Adapter finish and scan lines', () => {
  assert.equal(isShipped(entry('warn', 'bing', 'HTTP 429 x'), true), true);
  assert.equal(isShipped(entry('error', 'sw', 'boom'), false), true);
  assert.equal(isShipped(entry('info', 'meta', 'Adapter finish: ok, 3 ads'), true), true);
  assert.equal(isShipped(entry('info', 'scan', 'Scan start example.com (domain)'), true), true);
  assert.equal(isShipped(entry('info', 'scan', 'Scan end example.com: 3 ads'), true), true);
  assert.equal(isShipped(entry('info', 'meta', 'Adapter start'), true), false);
  assert.equal(isShipped(entry('info', 'scan', 'Advertiser names: X'), true), false);
  assert.equal(isShipped(entry('info', 'meta', 'Adapter finish: ok'), false), false);
  assert.equal(isShipped(entry('warn', SRC, 'Send failed'), true), false);
  assert.equal(worthSending([entry('info', 'scan', 'Scan start a.com')]), false);
  assert.equal(worthSending([entry('info', 'bing', 'Adapter finish: ok')]), true);
});

test('remote log: scan batch payload, headers and selection', async () => {
  const fetch = fakeFetch();
  const { rl } = make({ fetch });
  const id = rl.scanStart('example.com');
  rl.handle(entry('info', 'scan', 'Scan start example.com (domain)'));
  rl.handle(entry('info', 'google', 'Adapter start'));
  rl.handle(entry('info', 'google', 'Adapter finish: ok, 2 ads, 3 requests, 900ms'));
  rl.handle(entry('warn', 'bing', 'HTTP 429 adlibrary.api.bingads.microsoft.com/api/v1/Ads'));
  rl.handle(entry('info', 'scan', 'Advertiser names: Acme'));
  rl.handle(entry('info', 'scan', 'Scan end example.com: 2 ads (2 confirmed), 5000ms'));
  assert.equal(await rl.scanEnd(), true);

  assert.equal(fetch.calls.length, 1);
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, ENDPOINT);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers['X-Superpixel-Key'], INGEST_KEY);
  assert.deepEqual(Object.keys(body).sort(), ['entries', 'install', 'scan', 'version']);
  assert.equal(body.install, 'install-1');
  assert.equal(body.version, '9.9.9');
  assert.deepEqual(body.scan, { id, domain: 'example.com' });
  assert.deepEqual(
    body.entries.map((e) => e.msg),
    [
      'Scan start example.com (domain)',
      'Adapter finish: ok, 2 ads, 3 requests, 900ms',
      'HTTP 429 adlibrary.api.bingads.microsoft.com/api/v1/Ads',
      'Scan end example.com: 2 ads (2 confirmed), 5000ms',
    ],
  );
  assert.deepEqual(Object.keys(body.entries[0]).sort(), ['level', 'msg', 'src', 't']);
});

test('remote log: nothing is sent without consent, or when the scan has nothing to report', async () => {
  for (const consent of [null, false, undefined]) {
    const fetch = fakeFetch();
    const { rl } = make({ fetch, getConsent: () => consent });
    await rl.refreshConsent();
    rl.scanStart('example.com');
    rl.handle(entry('warn', 'bing', 'HTTP 429'));
    rl.handle(entry('info', 'bing', 'Adapter finish: rate_limited'));
    assert.equal(await rl.scanEnd(), false);
    rl.handle(entry('error', 'sw', 'Unhandled error: x'));
    assert.deepEqual(rl.pending().idle, []);
    await rl.flushIdle();
    assert.equal(fetch.calls.length, 0);
  }

  const fetch = fakeFetch();
  const { rl } = make({ fetch });
  rl.scanStart('example.com');
  rl.handle(entry('info', 'scan', 'Scan start example.com (domain)'));
  rl.handle(entry('info', 'scan', 'Scan stopped example.com'));
  assert.equal(await rl.scanEnd(), false);
  assert.equal(fetch.calls.length, 0);
});

test('remote log: chunks at 500 entries per request', async () => {
  const fetch = fakeFetch();
  const { rl } = make({ fetch });
  rl.scanStart('example.com');
  for (let i = 0; i < MAX_BATCH * 2 + 5; i++) rl.handle(entry('warn', 'tiktok', `warn ${i}`));
  assert.equal(await rl.scanEnd(), true);
  assert.deepEqual(fetch.calls.map((c) => c.body.entries.length), [500, 500, 5]);
  assert.equal(new Set(fetch.calls.map((c) => c.body.scan.id)).size, 1);
  assert.equal(fetch.calls[2].body.entries[4].msg, `warn ${MAX_BATCH * 2 + 4}`);

  // Large messages are split by size too, keeping each body under 256 KiB.
  const big = Array.from({ length: 400 }, (_, i) => entry('warn', 'meta', `${i} ${'x'.repeat(990)}`));
  const chunks = chunkEntries(big);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(JSON.stringify(c).length < 256 * 1024);
  assert.equal(chunks.flat().length, 400);
});

test('remote log: never throws on fetch rejection or HTTP errors, logs one line', async () => {
  const rejecting = async () => {
    throw new Error('network down');
  };
  const { rl, logged } = make({ fetch: rejecting });
  rl.scanStart('example.com');
  rl.handle(entry('error', 'linkedin', 'Adapter threw: x'));
  assert.equal(await rl.scanEnd(), false);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].level, 'info');
  assert.equal(logged[0].src, SRC);
  assert.match(logged[0].msg, /network down/);

  const http = make({ fetch: fakeFetch(429) });
  http.rl.scanStart('example.com');
  for (let i = 0; i < 700; i++) http.rl.handle(entry('warn', 'bing', `w ${i}`));
  assert.equal(await http.rl.scanEnd(), false);
  assert.equal(http.logged.length, 1);
  assert.match(http.logged[0].msg, /HTTP 429/);
});

test('remote log: the failure line is not shipped again (no loop)', async () => {
  await clearLog();
  let calls = 0;
  const rl = createRemoteLog({
    fetch: async () => {
      calls++;
      throw new Error('offline');
    },
    getConsent: () => true,
    getInstallId: () => 'install-1',
    log,
    idleDelayMs: 10,
  });
  const off = onEntry((e) => rl.handle(e));
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await rl.refreshConsent();
    rl.scanStart('example.com');
    log('warn', 'bing', 'HTTP 500 x');
    const ending = rl.scanEnd();
    rl.scanStart('next.com'); // the failure line lands while the next scan collects
    await ending;
    assert.equal(calls, 1);
    assert.deepEqual(rl.pending().scan, []);
    assert.equal(await rl.scanEnd(), false);
    assert.deepEqual(rl.pending().idle, []);
    await sleep(30);
    assert.equal(calls, 1);
  } finally {
    console.warn = origWarn;
    off();
    await clearLog();
  }
});

test('remote log: outside a scan only warn/error are buffered and sent debounced', async () => {
  const fetch = fakeFetch();
  const { rl } = make({ fetch, idleDelayMs: 20 });
  await rl.refreshConsent();
  rl.handle(entry('info', 'sw', 'Side panel closed'));
  rl.handle(entry('error', 'sw', 'Unhandled rejection: x'));
  await sleep(5);
  rl.handle(entry('warn', 'scan', 'Page probe failed'));
  assert.equal(fetch.calls.length, 0);
  await sleep(60);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].body.scan, null);
  assert.deepEqual(fetch.calls[0].body.entries.map((e) => e.level), ['error', 'warn']);

  rl.handle(entry('error', 'sw', 'again'));
  rl.setConsent(false); // declining drops the buffer
  await sleep(40);
  assert.equal(fetch.calls.length, 1);
});

test('remote log: install id is a stable uuid; consent defaults to never asked', async () => {
  const a = await getInstallId();
  const b = await getInstallId();
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(DEFAULT_SETTINGS.remoteLog, null);
});
