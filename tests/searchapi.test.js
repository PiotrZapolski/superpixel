import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ENGINES,
  supports,
  buildParams,
  mapGoogle,
  mapMeta,
  mapTiktok,
  mapLinkedin,
  mapResponse,
  fallback,
} from '../adapters/searchapi.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('supports and engine names', () => {
  for (const id of ['google', 'meta', 'tiktok', 'linkedin']) assert.equal(supports(id), true);
  for (const id of ['bing', 'snap', 'x']) assert.equal(supports(id), false);
  assert.equal(ENGINES.google, 'google_ads_transparency_center');
  assert.equal(ENGINES.meta, 'meta_ad_library');
  assert.equal(ENGINES.tiktok, 'tiktok_ads_library');
  assert.equal(ENGINES.linkedin, 'linkedin_ad_library');
});

test('buildParams per engine', () => {
  const seeds = { domain: 'tesla.com', brand: 'Tesla' };
  assert.equal(buildParams('google', seeds).domain, 'tesla.com');
  assert.equal(buildParams('meta', seeds).q, 'tesla.com');
  assert.equal(buildParams('tiktok', seeds).q, 'Tesla');
  assert.equal(buildParams('linkedin', seeds).advertiser, 'Tesla');
  assert.equal(buildParams('bing', seeds), null);
});

test('mapGoogle', () => {
  const ads = mapGoogle(fixture('searchapi-google.json'), 'tesla.com');
  assert.equal(ads.length, 2);
  const [a, b] = ads;
  assert.equal(a.platform, 'google');
  assert.equal(a.id, 'CR03335465984256376833');
  assert.equal(a.advertiserId, 'AR17828074650563772417');
  assert.equal(a.advertiserName, 'Tesla Inc.');
  assert.equal(a.format, 'video');
  assert.equal(a.firstShown, '2025-01-17');
  assert.equal(a.lastShown, '2025-03-04');
  assert.equal(a.match, 'confirmed');
  assert.equal(a.source, 'searchapi');
  assert.ok(a.detailUrl.includes('/creative/CR03335465984256376833'));
  assert.equal(b.match, 'keyword');
  assert.equal(b.previewUrl, 'https://tpc.googlesyndication.com/archive/simgad/123');
  assert.equal(mapGoogle({ ads: [] }, 'tesla.com'), null);
});

test('mapMeta', () => {
  const ads = mapMeta(fixture('searchapi-meta.json'), 'nike.com');
  assert.equal(ads.length, 2);
  const [a, b] = ads;
  assert.equal(a.platform, 'meta');
  assert.equal(a.id, '2063067314248831');
  assert.equal(a.advertiserId, '15087023444');
  assert.equal(a.advertiserName, 'Nike');
  assert.equal(a.landingUrl, 'https://www.nike.com/');
  assert.equal(a.title, '');
  assert.equal(a.text, 'Get the gear that\'s up for it all. Any time. Anywhere.');
  assert.equal(a.previewUrl, 'https://scontent.xx.fbcdn.net/v/t39/card1.jpg');
  assert.deepEqual(a.placements, ['facebook', 'instagram']);
  assert.equal(a.firstShown, '2026-06-22');
  assert.equal(a.isActive, true);
  assert.equal(a.match, 'confirmed');
  assert.equal(a.detailUrl, 'https://www.facebook.com/ads/library/?id=2063067314248831');
  assert.equal(b.match, 'keyword');
  assert.equal(b.previewUrl, 'https://scontent.xx.fbcdn.net/v/t39/img2.jpg');
  assert.equal(b.isActive, false);
});

test('mapTiktok', () => {
  const ads = mapTiktok(fixture('searchapi-tiktok.json'));
  assert.equal(ads.length, 2);
  assert.equal(ads[0].advertiserName, 'LIDL ROMANIA SRL');
  assert.equal(ads[0].advertiserId, '6952423671851909889');
  assert.equal(ads[0].detailUrl, 'https://library.tiktok.com/ads/detail/?ad_id=1875196624813153');
  assert.equal(ads[0].firstShown, '2026-09-02');
  assert.equal(ads[0].match, 'keyword');
  assert.equal(ads[1].advertiserName, '');
});

test('mapLinkedin skips entries without an ad id', () => {
  const ads = mapLinkedin(fixture('searchapi-linkedin.json'));
  assert.deepEqual(ads.map((a) => a.id), ['728824033', '728873973']);
  assert.equal(ads[0].advertiserName, 'Google Cloud');
  assert.equal(ads[0].format, 'image');
  assert.ok(ads[0].text.startsWith('Powered by Gemini'));
  assert.equal(ads[1].previewUrl, 'https://media.licdn.com/dms/image/v2/D4D10AQ/image-pad_1200/item1');
  assert.equal(ads[1].detailUrl, 'https://www.linkedin.com/ad-library/detail/728873973');
  assert.ok(ads.every((a) => a.match === 'name' && a.source === 'searchapi'));
});

test('mapResponse aggregates advertisers', () => {
  const r = mapResponse('google', fixture('searchapi-google.json'), 'tesla.com');
  assert.equal(r.ok, true);
  assert.equal(r.advertisers[0].id, 'AR17828074650563772417');
  assert.equal(r.advertisers[0].url, 'https://adstransparency.google.com/advertiser/AR17828074650563772417?region=anywhere');
  assert.equal(mapResponse('google', { nope: 1 }, 'tesla.com').ok, false);
});

function fakeResponse(obj, status = 200) {
  return { status, ok: status < 300, async text() { return JSON.stringify(obj); } };
}

test('fallback sends the key in a header only and maps the result', async () => {
  const KEY = 'sk_test_secret_123';
  const calls = [];
  const ctx = {
    settings: { searchapiKey: KEY },
    progress() {},
    async fetch(url, init) {
      calls.push({ url, init });
      return fakeResponse(fixture('searchapi-google.json'));
    },
  };
  const r = await fallback('google', { domain: 'tesla.com', brand: 'Tesla' }, ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'searchapi');
  assert.equal(r.ads.length, 2);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://www.searchapi.io/api/v1/search');
  assert.equal(u.searchParams.get('engine'), 'google_ads_transparency_center');
  assert.equal(u.searchParams.get('domain'), 'tesla.com');
  assert.ok(!calls[0].url.includes(KEY));
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!r.message.includes(KEY));
});

test('fallback without key or for unsupported platform does nothing', async () => {
  let called = false;
  const ctx = { settings: { searchapiKey: '' }, async fetch() { called = true; return fakeResponse({}); } };
  assert.equal((await fallback('google', { domain: 'a.com' }, ctx)).status, 'skipped');
  assert.equal((await fallback('bing', { domain: 'a.com' }, { ...ctx, settings: { searchapiKey: 'k' } })).status, 'skipped');
  assert.equal(called, false);
});

test('fallback maps errors and never leaks the key', async () => {
  const KEY = 'sk_leak_check';
  const ctx401 = { settings: { searchapiKey: KEY }, async fetch() { return fakeResponse({ error: 'Invalid API key' }, 401); } };
  const r1 = await fallback('meta', { domain: 'nike.com' }, ctx401);
  assert.equal(r1.status, 'error');
  const ctxErr = { settings: { searchapiKey: KEY }, async fetch() { throw new Error(`boom ${KEY}`); } };
  const r2 = await fallback('meta', { domain: 'nike.com' }, ctxErr);
  assert.equal(r2.status, 'error');
  assert.ok(!r2.message.includes(KEY));
  const ctx500 = { settings: { searchapiKey: KEY }, async fetch() { return fakeResponse({ error: `bad key ${KEY}` }, 500); } };
  const r3 = await fallback('meta', { domain: 'nike.com' }, ctx500);
  assert.ok(!r3.message.includes(KEY));
});
