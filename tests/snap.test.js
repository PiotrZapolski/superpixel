import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { meta, buildSnapBody, parseSnapAds, EU_COUNTRIES, search } from '../adapters/snap.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SNAP = JSON.parse(fixture('snap-search.json'));

test('meta', () => {
  assert.equal(meta.id, 'snap');
  assert.equal(meta.coverage, 'EU only');
});

test('buildSnapBody: EU27 lowercase, last 365 days', () => {
  const now = Date.UTC(2026, 8, 25);
  const body = buildSnapBody('Decathlon', now);
  assert.equal(body.paying_advertiser_name, 'Decathlon');
  assert.equal(body.countries.length, 27);
  assert.equal(EU_COUNTRIES.length, 27);
  assert.ok(body.countries.every((c) => /^[a-z]{2}$/.test(c)));
  assert.ok(body.countries.includes('de') && body.countries.includes('el'));
  assert.equal(body.end_date, '2026-09-25T00:00:00.000Z');
  assert.equal(Date.parse(body.end_date) - Date.parse(body.start_date), 365 * 86400000);
  assert.equal(buildSnapBody('X', new Date(now)).end_date, body.end_date);
});

test('parseSnapAds maps ad_previews', () => {
  const r = parseSnapAds(SNAP, 'decathlon.com');
  assert.equal(r.ok, true);
  assert.equal(r.nextLink, 'https://adsapi.snapchat.com/v1/ads_library/ads/search?cursor=NEXTPAGE');
  assert.equal(r.ads.length, 2);
  const [a, b] = r.ads;
  assert.equal(a.platform, 'snap');
  assert.equal(a.id, 'e3f1a9c2-88b4-4e77-9c1a-2f6d0a7b5c11');
  assert.equal(a.advertiserName, 'Decathlon SE');
  assert.equal(a.title, 'Gear up for summer');
  assert.equal(a.match, 'confirmed');
  assert.equal(new URL(a.landingUrl).hostname, 'www.decathlon.com');
  assert.equal(a.previewUrl, 'https://ads-media.snapchat.com/creatives/e3f1a9c2.jpg');
  assert.equal(a.isActive, true);
  assert.equal(a.firstShown, '2026-06-01');
  assert.equal(a.format, 'image');

  assert.equal(b.advertiserName, 'Decathlon Retail');
  assert.equal(b.match, 'name');
  assert.equal(b.isActive, false);
  assert.equal(b.previewUrl, '');
  assert.equal(b.format, 'video');
});

test('parseSnapAds: empty success is ok, unknown shape is not', () => {
  const empty = parseSnapAds({ request_status: 'SUCCESS', ad_previews: [] }, 'x.com');
  assert.equal(empty.ok, true);
  assert.equal(empty.ads.length, 0);
  assert.equal(parseSnapAds({ foo: 1 }, 'x.com').ok, false);
  assert.equal(parseSnapAds('not json', 'x.com').ok, false);
});

function fakeResponse(obj, status = 200) {
  return { status, ok: status < 300, async text() { return JSON.stringify(obj); } };
}

test('search() posts the body and follows next_link once', async () => {
  const calls = [];
  const ctx = {
    settings: {},
    progress() {},
    async fetch(url, init) {
      calls.push({ url, init });
      if (url.includes('cursor=NEXTPAGE')) return fakeResponse({ request_status: 'SUCCESS', ad_previews: [] });
      return fakeResponse(SNAP);
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'ok');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://adsapi.snapchat.com/v1/ads_library/ads/search');
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.paying_advertiser_name, 'Decathlon');
  assert.equal(res.ads.length, 2);
});

test('search() maps HTTP errors without throwing', async () => {
  const ctx = { settings: {}, async fetch() { return fakeResponse({ error: 'x' }, 500); } };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'error');
});

test('search() also queries up to 2 advertiser names, sequentially and throttled', async () => {
  const names = [];
  let throttles = 0;
  let inFlight = 0;
  const ctx = {
    settings: {},
    async throttle() { throttles += 1; },
    async fetch(url, init) {
      inFlight += 1;
      assert.equal(inFlight, 1);
      const body = JSON.parse(init.body);
      names.push(body.paying_advertiser_name);
      await Promise.resolve();
      inFlight -= 1;
      if (body.paying_advertiser_name === 'BLG') {
        return fakeResponse({
          request_status: 'SUCCESS',
          ad_previews: [{ ad_preview: { id: 'snap-1', name: 'Spring', paying_advertiser_name: 'BLG' } }],
        });
      }
      return fakeResponse({ request_status: 'SUCCESS', ad_previews: [] });
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'babylovegrowth', advertiserNames: ['BLG INC', 'BLG', 'Third'] }, ctx);
  assert.deepEqual(names, ['babylovegrowth', 'BLG INC', 'BLG']);
  assert.equal(throttles, 3);
  assert.equal(res.status, 'ok');
  assert.equal(res.ads.length, 1);
  assert.equal(res.ads[0].match, 'name');
});

test('search() reports empty with the searched names when nothing is found', async () => {
  const ctx = { settings: {}, async fetch() { return fakeResponse({ request_status: 'SUCCESS', ad_previews: [] }); } };
  const res = await search({ domain: 'x.com', brand: 'Acme', advertiserNames: ['Acme Corp'] }, ctx);
  assert.equal(res.status, 'empty');
  assert.match(res.message, /"Acme" \/ "Acme Corp"/);
});
