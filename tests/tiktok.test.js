import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  meta,
  buildSearchUrl,
  parseTiktokSearch,
  parseTiktokDetail,
  mapTiktokAd,
  adIdsFromHrefs,
  landingFromHrefs,
  advertiserUrl,
  deepLinks,
  search,
  searchPlan,
  MAX_SEARCH_CAPTURES,
  MAX_CAPTURE_RETRIES,
} from '../adapters/tiktok.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('meta', () => {
  assert.equal(meta.id, 'tiktok');
  assert.equal(meta.coverage, 'EU/EEA, UK, CH only');
});

test('buildSearchUrl covers the last 365 days in ms', () => {
  const now = 1758800000000;
  const u = new URL(buildSearchUrl({ region: 'DE', q: 'nike', now }));
  assert.equal(u.origin + u.pathname, 'https://library.tiktok.com/ads');
  assert.equal(u.searchParams.get('region'), 'DE');
  assert.equal(u.searchParams.get('adv_name'), 'nike');
  assert.equal(u.searchParams.get('query_type'), '1');
  assert.equal(u.searchParams.get('adv_biz_ids'), '');
  assert.equal(u.searchParams.get('sort_type'), 'last_shown_date,desc');
  assert.equal(u.searchParams.get('end_time'), String(now));
  assert.equal(u.searchParams.get('start_time'), String(now - 365 * 86400000));
});

test('parseTiktokSearch: shape A (data.items with flat advertiser fields)', () => {
  const r = parseTiktokSearch(fixture('tiktok-search-a.json'));
  assert.equal(r.ok, true);
  assert.equal(r.rateLimited, false);
  assert.equal(r.ads.length, 2);
  const a = r.ads[0];
  assert.equal(a.id, '1800000000000001');
  assert.equal(a.advertiserName, 'Decathlon');
  assert.equal(a.bizId, '7000000000000000001');
  assert.equal(a.firstShown, '2024-07-01');
  assert.equal(a.lastShown, '2024-09-24');
  assert.equal(a.reach, '10K-100K');
  assert.equal(a.previewUrl, 'https://p16-sign.tiktokcdn-eu.com/obj/cover1.jpeg');
  assert.equal(r.ads[1].firstShown, '2024-08-15');
});

test('parseTiktokSearch: shape B (data[] with nested advertiser, numeric ad_id)', () => {
  const r = parseTiktokSearch(fixture('tiktok-search-b.json'));
  assert.equal(r.ok, true);
  assert.equal(r.ads.length, 1);
  const a = r.ads[0];
  assert.equal(a.id, '1800000000000003');
  assert.equal(a.advertiserName, 'Decathlon UK');
  assert.equal(a.bizId, '7000000000000000002');
  assert.equal(a.firstShown, '2024-08-01');
  assert.equal(a.lastShown, '2024-09-01');
  assert.equal(a.reach, '1K-10K');
  assert.equal(a.previewUrl, 'https://p16.tiktokcdn.com/img/ad3.jpg');
  assert.equal(a.format, 'image');
});

test('parseTiktokSearch: plain-text and JSON rate limits', () => {
  const busy = parseTiktokSearch(fixture('tiktok-busy.txt'));
  assert.equal(busy.rateLimited, true);
  assert.equal(busy.ok, false);
  assert.deepEqual(busy.ads, []);
  assert.equal(parseTiktokSearch('limit exceed').rateLimited, true);
  assert.equal(parseTiktokSearch('{"code":40100,"msg":"limit exceed"}').rateLimited, true);
});

test('parseTiktokSearch: empty list is ok, garbage is not', () => {
  const empty = parseTiktokSearch('{"code":0,"data":{"items":[],"total":0}}');
  assert.equal(empty.ok, true);
  assert.equal(empty.ads.length, 0);
  const html = parseTiktokSearch('<html>oops</html>');
  assert.equal(html.ok, false);
  assert.equal(html.rateLimited, false);
});

test('parseTiktokDetail finds the external landing and advertiser info', () => {
  const d = parseTiktokDetail(fixture('tiktok-detail.json'));
  assert.equal(d.ok, true);
  assert.equal(new URL(d.landingUrl).hostname, 'www.decathlon.com');
  assert.equal(d.advertiserName, 'Decathlon');
  assert.equal(d.bizId, '7000000000000000001');
  assert.equal(d.paidBy, 'Decathlon SE');
});

test('parseTiktokDetail ignores TikTok/CDN urls and flags rate limits', () => {
  const d = parseTiktokDetail({ data: { share_url: 'https://www.tiktok.com/@x', cover_url: 'https://p16-sign.tiktokcdn-eu.com/a.jpeg' } });
  assert.equal(d.landingUrl, '');
  assert.equal(parseTiktokDetail('system busy').rateLimited, true);
});

test('mapTiktokAd confirms by landing host and builds links', () => {
  const raw = parseTiktokSearch(fixture('tiktok-search-a.json')).ads[0];
  const ad = mapTiktokAd({ ...raw, landingUrl: 'https://www.decathlon.com/trail' }, 'decathlon.com');
  assert.equal(ad.platform, 'tiktok');
  assert.equal(ad.match, 'confirmed');
  assert.equal(ad.advertiserId, '7000000000000000001');
  assert.equal(ad.detailUrl, 'https://library.tiktok.com/ads/detail/?ad_id=1800000000000001');
  const other = mapTiktokAd(parseTiktokSearch(fixture('tiktok-search-a.json')).ads[1], 'decathlon.com');
  assert.equal(other.match, 'keyword');
  const u = new URL(advertiserUrl('7000000000000000001', 'Decathlon'));
  assert.equal(u.searchParams.get('adv_biz_ids'), '7000000000000000001');
  assert.equal(u.searchParams.get('query_type'), '2');
  assert.equal(u.searchParams.get('region'), 'all');
});

test('DOM fallback helpers', () => {
  assert.deepEqual(
    adIdsFromHrefs([
      'https://library.tiktok.com/ads/detail/?ad_id=111111',
      'https://library.tiktok.com/ads/detail/?ad_id=111111',
      'https://library.tiktok.com/ads/detail/?foo=1&ad_id=222222',
      'https://library.tiktok.com/ads',
    ]),
    ['111111', '222222'],
  );
  assert.equal(
    landingFromHrefs(['https://www.tiktok.com/legal', 'https://p16.tiktokcdn.com/x.jpg', 'https://www.decathlon.com/']),
    'https://www.decathlon.com/',
  );
});

test('deepLinks use region=all', () => {
  const [l] = deepLinks({ domain: 'decathlon.com', brand: 'Decathlon' });
  assert.equal(new URL(l.url).searchParams.get('region'), 'all');
  assert.equal(new URL(l.url).searchParams.get('adv_name'), 'Decathlon');
});

test('search() with captured payloads', async () => {
  const calls = [];
  const ctx = {
    settings: { tiktokRegions: [], tiktokDetails: 1 },
    progress() {},
    async capture(url) {
      calls.push(url);
      if (url.includes('/ads/detail/')) {
        return { payloads: [{ url: 'https://library.tiktok.com/api/v1/items/1800000000000001/details', status: 200, body: fixture('tiktok-detail.json') }] };
      }
      return { payloads: [{ url: 'https://library.tiktok.com/api/v1/search?region=all&type=1', status: 200, body: fixture('tiktok-search-a.json') }] };
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'ok');
  assert.equal(res.platform, 'tiktok');
  // keyword search (query_type 1) + advertiser-name search (query_type 2) + 1 detail
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.filter((u) => !u.includes('/ads/detail/')).map((u) => new URL(u).searchParams.get('query_type')),
    ['1', '2'],
  );
  const byId = Object.fromEntries(res.ads.map((a) => [a.id, a]));
  assert.equal(byId['1800000000000001'].match, 'confirmed');
  assert.equal(byId['1800000000000002'].match, 'advertiser');
  assert.equal(res.advertisers.length, 1);
  assert.equal(res.advertisers[0].confirmedCount, 1);
});

test('search() maps rate limit status without throwing', async () => {
  const ctx = {
    settings: { tiktokRegions: ['DE'], tiktokDetails: 0 },
    async capture() {
      return { payloads: [{ url: 'https://library.tiktok.com/api/v1/search?region=all', status: 421, body: 'system busy' }] };
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'rate_limited');
});

test('search() reports changed when payloads are unparseable', async () => {
  const ctx = {
    settings: { tiktokRegions: [], tiktokDetails: 0 },
    async capture() {
      return { payloads: [{ url: 'https://library.tiktok.com/api/v1/search?region=all', status: 200, body: '<html></html>' }] };
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'changed');
  assert.equal(res.message, 'TikTok changed its response format');
});

// ---- cross-platform advertiser names (seeds.advertiserNames) ----

test('searchPlan: keyword brand, then up to 2 advertiser names and the brand as query_type 2, max 4', () => {
  assert.deepEqual(searchPlan('babylovegrowth', 'babylovegrowth', ['BLG INC', 'BLG', 'Babylovegrowth', 'Other']), [
    { q: 'babylovegrowth', queryType: 1 },
    { q: 'BLG INC', queryType: 2 },
    { q: 'BLG', queryType: 2 },
    { q: 'babylovegrowth', queryType: 2 },
  ]);
  assert.deepEqual(searchPlan('Decathlon', 'decathlon', []), [
    { q: 'Decathlon', queryType: 1 },
    { q: 'Decathlon', queryType: 2 },
  ]);
  assert.deepEqual(searchPlan('Acme Shoes', 'acme', undefined).map((s) => `${s.queryType}:${s.q}`), ['1:Acme Shoes', '2:Acme Shoes', '1:acme']);
  assert.equal(MAX_SEARCH_CAPTURES, 4);
});

test('search() bounds search captures at 4; a name-only advertiser without a confirmed ad is dropped', async () => {
  const searches = [];
  const nameOnly = JSON.stringify({
    code: 0,
    data: { items: [{ id: '1900000000000009', name: 'BLG INC', adv_biz_id: '7100000000000000009', videos: [] }] },
  });
  const ctx = {
    settings: { tiktokRegions: ['DE', 'FR', 'GB', 'IT'], tiktokDetails: 0 },
    async capture(url) {
      const u = new URL(url);
      searches.push(`${u.searchParams.get('query_type')}:${u.searchParams.get('adv_name')}:${u.searchParams.get('region')}`);
      const body = u.searchParams.get('adv_name') === 'BLG INC'
        ? nameOnly
        : JSON.stringify({ code: 0, data: { items: [] } });
      return { payloads: [{ url: 'https://library.tiktok.com/api/v1/search?region=all&type=1', status: 200, body }] };
    },
    async captureDom() { throw new Error('DOM fallback must not run when JSON was parsed'); },
  };
  const res = await search({
    domain: 'babylovegrowth.ai',
    brand: 'babylovegrowth',
    advertiserNames: ['BLG INC', 'BLG', 'Babylovegrowth'],
  }, ctx);
  assert.deepEqual(searches, ['1:babylovegrowth:all', '2:BLG INC:all', '2:BLG:all', '2:babylovegrowth:all']);
  // Same name, but no ad points to the domain: not shown (live finding outrank.so, 2026-09-26).
  assert.equal(res.status, 'empty');
  assert.equal(res.message, 'No TikTok ads point to babylovegrowth.ai (searched: babylovegrowth, BLG INC, BLG)');
  assert.deepEqual(res.ads, []);
  assert.deepEqual(res.advertisers, []);
  // Advertiser-name-only hits are still mapped as 'name' matches.
  assert.equal(mapTiktokAd({ id: '1900000000000009', advertiserName: 'BLG INC', viaName: true }, 'babylovegrowth.ai').match, 'name');
});

test('search() keeps only advertisers with an ad pointing to the domain', async () => {
  const body = JSON.stringify({
    code: 0,
    data: {
      items: [
        { id: '1900000000000001', name: 'Outrank', adv_biz_id: '7100000000000000001', external_url: 'https://outrank.so/pricing', videos: [] },
        { id: '1900000000000002', name: 'Outrank', adv_biz_id: '7100000000000000001', videos: [] },
        { id: '1900000000000003', name: 'Outrank IE', adv_biz_id: '7100000000000000003', external_url: 'https://outrank.ie/', videos: [] },
      ],
    },
  });
  const ctx = {
    settings: { tiktokRegions: [], tiktokDetails: 0 },
    async capture() {
      return { payloads: [{ url: 'https://library.tiktok.com/api/v1/search?region=all&type=1', status: 200, body }] };
    },
  };
  const res = await search({ domain: 'outrank.so', brand: 'Outrank' }, ctx);
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.ads.map((a) => [a.id, a.match]), [['1900000000000001', 'confirmed'], ['1900000000000002', 'advertiser']]);
  assert.deepEqual(res.advertisers.map((a) => a.id), ['7100000000000000001']);
  assert.match(res.message, /^2 ads, 1 pointing to outrank\.so/);
});

test('search() spends only the leftover budget on per-region retries', async () => {
  const searches = [];
  const ctx = {
    settings: { tiktokRegions: ['DE', 'FR', 'GB', 'IT', 'ES'], tiktokDetails: 0 },
    async capture(url) {
      const u = new URL(url);
      searches.push(`${u.searchParams.get('query_type')}:${u.searchParams.get('region')}`);
      return { payloads: [{ url: 'https://library.tiktok.com/api/v1/search', status: 200, body: '{"code":0,"data":{"items":[]}}' }] };
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.deepEqual(searches, ['1:all', '2:all', '1:DE', '1:FR']);
  assert.equal(res.status, 'empty');
});

// ---- transient capture failures (tab closed / load timeout) ----

const searchPayload = () => ({ payloads: [{ url: 'https://library.tiktok.com/api/v1/search?region=all', status: 200, body: fixture('tiktok-search-a.json') }] });

test('search() retries a tab_closed search capture once, without spending the search budget', async () => {
  const calls = [];
  const sleeps = [];
  const logs = [];
  const ctx = {
    settings: { tiktokRegions: [], tiktokDetails: 0 },
    sleep: async (ms) => { sleeps.push(ms); },
    log: (level, msg) => logs.push({ level, msg }),
    async capture(url) {
      calls.push(url);
      if (calls.length === 1) return { payloads: [], tabUrl: '', error: 'tab_closed' };
      return searchPayload();
    },
    async captureDom() { throw new Error('DOM fallback must not run after a successful retry'); },
  };
  // A plan of 4 searches (= MAX_SEARCH_CAPTURES): all 4 still run after the retry.
  await search({ domain: 'decathlon.com', brand: 'Decathlon', advertiserNames: ['Decathlon SE', 'Decathlon Retail'] }, ctx);
  assert.equal(calls.length, MAX_SEARCH_CAPTURES + 1);
  assert.equal(calls[0], calls[1], 'the retry repeats the same search');
  assert.deepEqual(sleeps, [2000]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].msg, /tab_closed, retrying/);
});

test('search() caps capture retries per run and names the reason when the tab keeps closing', async () => {
  let captures = 0;
  let doms = 0;
  const sleeps = [];
  const ctx = {
    settings: { tiktokRegions: [], tiktokDetails: 0 },
    sleep: async (ms) => { sleeps.push(ms); },
    async capture() { captures += 1; return { payloads: [], tabUrl: '', error: 'tab_closed' }; },
    async captureDom() { doms += 1; return { text: '', hrefs: [], tabUrl: '', error: 'tab_closed' }; },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(sleeps.length, MAX_CAPTURE_RETRIES);
  // Budget 4 (capture + DOM for each of the 2 planned searches) plus the 2 retries.
  assert.equal(captures + doms, MAX_SEARCH_CAPTURES + MAX_CAPTURE_RETRIES);
  assert.equal(res.status, 'error');
  assert.equal(res.message, 'TikTok search data was not captured (capture tab closed right after loading)');
});

test('search() names a load timeout, and keeps the old wording for other failures', async () => {
  const timeoutCtx = {
    settings: { tiktokRegions: [], tiktokDetails: 0 },
    sleep: async () => {},
    async capture() { return { payloads: [], tabUrl: '', error: 'timeout' }; },
  };
  const t = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, timeoutCtx);
  assert.equal(t.message, 'TikTok search data was not captured (page load timed out)');

  let slept = 0;
  const otherCtx = {
    settings: { tiktokRegions: [], tiktokDetails: 0 },
    sleep: async () => { slept += 1; },
    async capture() { return { payloads: [], tabUrl: '', error: '' }; },
  };
  const o = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, otherCtx);
  assert.equal(slept, 0, 'no retry without a transient error');
  assert.equal(o.message, 'TikTok search data was not captured (page did not load)');
});
