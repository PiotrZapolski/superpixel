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
  assert.equal(calls.length, 2);
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
