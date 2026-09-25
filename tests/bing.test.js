import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { meta, parseBingAdvertisers, parseBingAds, filterBingAds, advertiserUrl, search } from '../adapters/bing.js';

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
