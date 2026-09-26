import { test } from 'node:test';
import assert from 'node:assert/strict';

import { manualLibraries, xHandle } from '../adapters/manual.js';

test('manualLibraries lists X, Pinterest and Apple with hints', () => {
  const libs = manualLibraries({
    domain: 'babylovegrowth.ai',
    brand: 'BabyLoveGrowth',
    social: { x: ['https://x.com/babylovegrowth'] },
  });
  assert.deepEqual(libs.map((l) => l.id), ['x', 'pinterest', 'apple']);
  const [x, pin, apple] = libs;
  assert.equal(x.label, 'X (Twitter)');
  assert.equal(x.coverage, 'EU only');
  assert.equal(x.handle, 'babylovegrowth');
  assert.equal(x.url, 'https://ads.x.com/ads-repository');
  assert.equal(x.hint, 'X builds a CSV report per handle; open and search for @babylovegrowth');
  assert.equal(pin.url, 'https://ads.pinterest.com/ads-repository/');
  assert.equal(pin.hint, 'Filter by advertiser name BabyLoveGrowth');
  assert.equal(apple.label, 'Apple App Store');
  assert.equal(apple.url, 'https://adrepository.apple.com/');
  assert.equal(apple.hint, 'Only App Store app ads; search the developer name');
  for (const l of libs) assert.ok(l.label && l.coverage && l.url && l.hint, l.id);
});

test('manualLibraries without social links or seeds', () => {
  const libs = manualLibraries({ domain: 'example.com', brand: 'Example', social: { x: [] } });
  assert.equal(libs[0].handle, '');
  assert.ok(!libs[0].hint.includes('@'));
  const bare = manualLibraries(undefined);
  assert.equal(bare.length, 3);
  assert.equal(bare[1].hint, 'Filter by advertiser name');
});

test('xHandle reads x.com and twitter.com links, skips intent/share', () => {
  assert.equal(xHandle({ social: { x: ['https://twitter.com/intent/tweet', 'https://twitter.com/Acme_1'] } }), 'Acme_1');
  assert.equal(xHandle({ social: { x: ['https://x.com/share?url=1'] } }), '');
  assert.equal(xHandle({}), '');
});
