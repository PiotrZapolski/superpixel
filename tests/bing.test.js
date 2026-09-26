import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  meta,
  parseBingAdvertisers,
  parseBingAds,
  filterBingAds,
  advertiserUrl,
  search,
  advertisersUrl,
  adsByAdvertiserUrl,
  adsBySearchUrl,
  mergeAdvertiserLists,
  ADS_TOP,
} from '../adapters/bing.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ADVERTISERS = JSON.parse(fixture('bing-advertisers.json'));
const ADS = JSON.parse(fixture('bing-ads.json'));

test('meta', () => {
  assert.equal(meta.id, 'bing');
  assert.equal(meta.label, 'Microsoft Advertising (Bing)');
  assert.equal(meta.coverage, 'EU/EEA-served ads');
});

test('parseBingAdvertisers', () => {
  const list = parseBingAdvertisers(ADVERTISERS);
  assert.deepEqual(list, [
    { id: '1001', name: 'Decathlon', country: 'France', verified: true },
    { id: '1002', name: 'Sport Reseller GmbH', country: 'Germany', verified: false },
  ]);
  assert.equal(parseBingAdvertisers({ items: [] }), null);
  assert.equal(parseBingAdvertisers('not json'), null);
});

test('parseBingAds maps fields and match', () => {
  const r = parseBingAds(ADS, 'decathlon.com');
  assert.equal(r.total, 3);
  assert.equal(r.ads.length, 3);
  const [a, b, c] = r.ads;
  assert.equal(a.platform, 'bing');
  assert.equal(a.id, '5001');
  assert.equal(a.advertiserId, '1001');
  assert.equal(a.advertiserName, 'Decathlon');
  assert.equal(a.title, 'Decathlon Official Site');
  assert.equal(a.text, 'Sports gear for everyone. Free returns.');
  assert.equal(a.displayUrl, 'www.decathlon.com/running');
  assert.equal(new URL(a.landingUrl).hostname, 'www.decathlon.com');
  assert.equal(a.detailUrl, 'https://adlibrary.ads.microsoft.com/ad-details?adId=5001');
  assert.equal(a.format, 'text');
  assert.equal(a.match, 'confirmed');

  // Confirmed through the display URL alone; AssetJson with an image.
  assert.equal(b.match, 'confirmed');
  assert.equal(b.format, 'image');
  assert.equal(b.previewUrl, 'https://tse1.mm.bing.net/images/trail.jpg');

  assert.equal(c.match, 'keyword');
  assert.equal(c.advertiserId, '1002');
  assert.equal(parseBingAds({ nope: true }, 'decathlon.com'), null);
});

test('filterBingAds drops advertisers without confirmed ads', () => {
  const { ads } = parseBingAds(ADS, 'decathlon.com');
  const kept = filterBingAds(ads, ['1001', '1002']);
  assert.deepEqual(kept.map((a) => a.id), ['5001', '5002']);
});

test('filterBingAds keeps top 2 advertisers as name matches when none is confirmed', () => {
  const { ads } = parseBingAds(ADS, 'example.org');
  const kept = filterBingAds(ads, ['1002', '1001', '1003']);
  assert.equal(kept.length, 3);
  assert.ok(kept.every((a) => a.match === 'name'));
  const onlyFirst = filterBingAds(ads, ['1002']);
  assert.deepEqual(onlyFirst.map((a) => a.id), ['5003']);
});

test('advertiserUrl', () => {
  assert.equal(advertiserUrl('1001'), 'https://adlibrary.ads.microsoft.com/?advertiserId=1001');
});

function fakeResponse(obj, status = 200) {
  return { status, ok: status < 300, async text() { return typeof obj === 'string' ? obj : JSON.stringify(obj); } };
}

test('search() end to end with fake fetch', async () => {
  const urls = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    progress() {},
    async fetch(url) {
      urls.push(url);
      if (url.includes('/Advertisers?')) return fakeResponse(ADVERTISERS);
      if (url.includes('advertiserId=1001')) return fakeResponse(ADS);
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'ok');
  assert.ok(urls[0].startsWith('https://adlibrary.api.bingads.microsoft.com/api/v1/Advertisers?searchText=Decathlon'));
  assert.ok(urls.some((u) => u.includes('Ads?searchText=decathlon.com')));
  assert.deepEqual(res.ads.map((a) => a.id).sort(), ['5001', '5002']);
  assert.equal(res.advertisers.length, 1);
  assert.equal(res.advertisers[0].id, '1001');
  assert.equal(res.advertisers[0].country, 'France');
  assert.equal(res.advertisers[0].url, 'https://adlibrary.ads.microsoft.com/?advertiserId=1001');
});

test('search() reports changed on unexpected shape', async () => {
  const ctx = { settings: {}, async fetch() { return fakeResponse({ unexpected: 1 }); } };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'changed');
});

// ---- live findings 2026-09-26: top <= 24, pagination, 429 handling, advertiser names ----

function adsPage(advertiserId, count, total, { domain = 'babylovegrowth.ai', offset = 0 } = {}) {
  const value = [];
  for (let i = 0; i < count; i += 1) {
    value.push({
      AdId: 9000 + offset + i,
      AdvertiserName: 'BLG',
      AdvertiserId: advertiserId,
      Title: `Ad ${offset + i}`,
      Description: 'AI SEO content',
      DisplayUrl: domain,
      DestinationUrl: `https://${domain}/`,
      AssetJson: null,
    });
  }
  return { '@odata.count': total, value };
}

test('URL builders: Ads top is capped at 24, Advertisers keeps 20', () => {
  assert.equal(ADS_TOP, 24);
  assert.ok(advertisersUrl('BLG').endsWith('searchText=BLG&top=20&skip=0'));
  assert.ok(adsByAdvertiserUrl('1001').endsWith('advertiserId=1001&top=24&skip=0'));
  assert.ok(adsByAdvertiserUrl('1001', 50, 24).endsWith('advertiserId=1001&top=24&skip=24'));
  assert.ok(adsBySearchUrl('x.com', 50).endsWith('searchText=x.com&top=24&skip=0'));
});

test('mergeAdvertiserLists: round robin, dedupe by id, cap', () => {
  const a = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const b = [{ id: '2' }, { id: '9' }];
  assert.deepEqual(mergeAdvertiserLists([a, b], 6).map((x) => x.id), ['1', '2', '3', '9']);
  assert.deepEqual(mergeAdvertiserLists([a, b], 2).map((x) => x.id), ['1', '2']);
  assert.deepEqual(mergeAdvertiserLists([[], b], 6).map((x) => x.id), ['2', '9']);
});

test('search() pages Ads with top=24 and skip (max 2 pages), never top > 24', async () => {
  const urls = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    async fetch(url) {
      urls.push(url);
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [{ AdvertiserId: 2001, AdvertiserName: 'BLG', AdvertiserCountry: 'US' }] });
      if (url.includes('advertiserId=2001') && url.endsWith('skip=0')) return fakeResponse(adsPage(2001, 24, 60));
      if (url.includes('advertiserId=2001') && url.endsWith('skip=24')) return fakeResponse(adsPage(2001, 24, 60, { offset: 24 }));
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'BLG' }, ctx);
  assert.equal(res.status, 'ok');
  const adsCalls = urls.filter((u) => u.includes('/Ads?advertiserId='));
  assert.equal(adsCalls.length, 2);
  assert.ok(urls.every((u) => !/[?&]top=(\d+)/.test(u) || Number(/[?&]top=(\d+)/.exec(u)[1]) <= 24));
  assert.equal(res.ads.length, 48);
});

test('search() stops paging when the first page is not full', async () => {
  const urls = [];
  const ctx = {
    settings: {},
    async fetch(url) {
      urls.push(url);
      if (url.includes('/Advertisers?')) return fakeResponse(ADVERTISERS);
      if (url.includes('advertiserId=1001')) return fakeResponse(ADS);
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(urls.filter((u) => u.includes('advertiserId=1001')).length, 1);
});

test('search() retries a 429 (HTML body) twice, then rate_limited, never changed', async () => {
  let calls = 0;
  const delays = [];
  const ctx = {
    settings: {},
    retryDelay(attempt) { delays.push(attempt); return 0; },
    async fetch() {
      calls += 1;
      return fakeResponse('<html><body>Too Many Requests</body></html>', 429);
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'rate_limited');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [0, 1]);
});

test('search() recovers when a 429 is followed by a normal answer', async () => {
  let first = true;
  const ctx = {
    settings: {},
    retryDelay: () => 0,
    async fetch(url) {
      if (first) { first = false; return fakeResponse('<html>busy</html>', 429); }
      if (url.includes('/Advertisers?')) return fakeResponse(ADVERTISERS);
      if (url.includes('advertiserId=1001')) return fakeResponse(ADS);
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'decathlon.com', brand: 'Decathlon' }, ctx);
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.ads.map((a) => a.id).sort(), ['5001', '5002']);
});

test('search() also searches advertisers by seeds.advertiserNames', async () => {
  const searched = [];
  const ctx = {
    settings: { bingAdvertisers: 6 },
    async fetch(url) {
      if (url.includes('/Advertisers?')) {
        const q = new URL(url).searchParams.get('searchText');
        searched.push(q);
        if (q === 'BLG') return fakeResponse({ value: [{ AdvertiserId: 2001, AdvertiserName: 'BLG', AdvertiserCountry: 'US' }] });
        return fakeResponse({ value: [] });
      }
      if (url.includes('advertiserId=2001')) return fakeResponse(adsPage(2001, 3, 3));
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'babylovegrowth', advertiserNames: ['BLG INC', 'BLG', 'babylovegrowth'] }, ctx);
  assert.deepEqual(searched, ['babylovegrowth', 'BLG INC', 'BLG']);
  assert.equal(res.status, 'ok');
  assert.equal(res.advertisers.length, 1);
  assert.equal(res.advertisers[0].id, '2001');
  assert.ok(res.ads.every((a) => a.match === 'confirmed'));
});

// ---- live finding 2026-09-26: name search returns unrelated advertisers with 0 confirmed ads ----

test('search() returns empty with no advertisers when no ad points to the domain', async () => {
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      if (url.includes('/Advertisers?')) {
        return fakeResponse({ value: [
          { AdvertiserId: 3001, AdvertiserName: 'GMC of Goshen BLGMCG - Bob Loquercio Auto Group', AdvertiserCountry: 'US' },
          { AdvertiserId: 3002, AdvertiserName: 'BLG srl', AdvertiserCountry: 'IT' },
        ] });
      }
      if (url.includes('advertiserId=3001')) return fakeResponse(adsPage(3001, 3, 3, { domain: 'goshengmc.com' }));
      if (url.includes('advertiserId=3002')) return fakeResponse(adsPage(3002, 2, 2, { domain: 'blg.it', offset: 50 }));
      return fakeResponse({ '@odata.count': 0, value: [] });
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'BabyLoveGrowth', advertiserNames: ['BLG INC', 'BLG'] }, ctx);
  assert.equal(res.status, 'empty');
  assert.equal(res.message, 'No Bing ads point to babylovegrowth.ai (searched: BabyLoveGrowth, BLG INC, BLG)');
  assert.deepEqual(res.ads, []);
  assert.deepEqual(res.advertisers, []);
});

test('search() rate limited without confirmed ads shows no unrelated advertisers', async () => {
  let n = 0;
  const ctx = {
    settings: { bingAdvertisers: 6 },
    retryDelay: () => 0,
    async fetch(url) {
      n += 1;
      if (url.includes('/Advertisers?')) return fakeResponse({ value: [{ AdvertiserId: 3002, AdvertiserName: 'BLG srl' }] });
      if (url.includes('advertiserId=3002')) return fakeResponse(adsPage(3002, 2, 2, { domain: 'blg.it' }));
      return fakeResponse('<html>Too Many Requests</html>', 429);
    },
  };
  const res = await search({ domain: 'babylovegrowth.ai', brand: 'BLG' }, ctx);
  assert.ok(n > 0);
  assert.equal(res.status, 'rate_limited');
  assert.deepEqual(res.ads, []);
  assert.deepEqual(res.advertisers, []);
});
