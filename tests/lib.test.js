import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDomain,
  hostOf,
  registrableDomain,
  domainLabel,
  hostMatches,
  unwrapRedirect,
  stripTracking,
} from '../lib/domain.js';
import { sleep, withTimeout, walkJson, parseJsonLines, toIsoDate, uniq, pick } from '../lib/util.js';
import { decodeEntities, stripTags, attrValues, extractHrefs, splitByClass, firstClassText } from '../lib/html.js';
import {
  PLATFORM_ORDER,
  makeAd,
  makeAdvertiser,
  makeResult,
  aggregateAdvertisers,
  promoteAdvertiserMatches,
  dedupeAds,
} from '../lib/model.js';

// ---- lib/domain.js ----

test('normalizeDomain handles URLs, bare domains and whitespace', () => {
  assert.equal(normalizeDomain('https://www.Example.co.uk/path?x'), 'example.co.uk');
  assert.equal(normalizeDomain('example.com'), 'example.com');
  assert.equal(normalizeDomain(' www.example.com '), 'example.com');
  assert.equal(normalizeDomain('http://shop.example.com:8080/a#b'), 'shop.example.com');
  assert.equal(normalizeDomain('not a domain'), '');
  assert.equal(normalizeDomain('localhost'), '');
  assert.equal(normalizeDomain(''), '');
  assert.equal(normalizeDomain(null), '');
});

test('hostOf strips www and accepts protocol-less input', () => {
  assert.equal(hostOf('https://WWW.Decathlon.com/fr/x'), 'decathlon.com');
  assert.equal(hostOf('example.com/x'), 'example.com');
  assert.equal(hostOf('//cdn.example.com/a.js'), 'cdn.example.com');
  assert.equal(hostOf(''), '');
});

test('registrableDomain and domainLabel handle multi-part suffixes', () => {
  assert.equal(registrableDomain('shop.decathlon.co.uk'), 'decathlon.co.uk');
  assert.equal(registrableDomain('www.decathlon.co.uk'), 'decathlon.co.uk');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('shop.allegro.com.pl'), 'allegro.com.pl');
  assert.equal(domainLabel('shop.decathlon.co.uk'), 'decathlon');
  assert.equal(domainLabel('decathlon.com'), 'decathlon');
});

test('hostMatches: subdomains, sibling TLDs, mismatches', () => {
  assert.equal(hostMatches('https://shop.decathlon.com/p/1', 'decathlon.com'), true);
  assert.equal(hostMatches('decathlon.com', 'decathlon.com'), true);
  assert.equal(hostMatches('https://www.decathlon.fr/', 'decathlon.com'), true);
  assert.equal(hostMatches('https://www.decathlon.fr/', 'decathlon.com', { siblingTlds: false }), false);
  assert.equal(hostMatches('https://decathlon.co.uk/x', 'decathlon.com'), true);
  assert.equal(hostMatches('https://nike.com/', 'decathlon.com'), false);
  assert.equal(hostMatches('https://decathlon.com.evil.net/', 'decathlon.com', { siblingTlds: false }), false);
  assert.equal(hostMatches('', 'decathlon.com'), false);
  assert.equal(hostMatches('https://decathlon.com', ''), false);
});

test('unwrapRedirect unwraps facebook, linkedin, google and doubleclick', () => {
  const target = 'https://www.decathlon.com/sale?utm_source=fb';
  assert.equal(unwrapRedirect(`https://l.facebook.com/l.php?u=${encodeURIComponent(target)}&h=AT0x`), target);
  assert.equal(unwrapRedirect(`https://lm.facebook.com/l.php?u=${encodeURIComponent(target)}`), target);
  assert.equal(
    unwrapRedirect(`https://www.linkedin.com/redir/redirect?url=${encodeURIComponent(target)}&urlhash=abc`),
    target,
  );
  assert.equal(unwrapRedirect(`https://www.google.com/url?q=${encodeURIComponent(target)}&sa=D`), target);
  assert.equal(
    unwrapRedirect('https://ad.doubleclick.net/ddm/clk/123;456;x;?https://www.decathlon.com/landing'),
    'https://www.decathlon.com/landing',
  );
  // nested: facebook -> google -> target
  const nested = `https://l.facebook.com/l.php?u=${encodeURIComponent(`https://www.google.com/url?q=${encodeURIComponent(target)}`)}`;
  assert.equal(unwrapRedirect(nested), target);
  assert.equal(unwrapRedirect('https://lnkd.in/abc'), 'https://lnkd.in/abc');
  assert.equal(unwrapRedirect('not a url'), 'not a url');
});

test('stripTracking removes utm and click ids only', () => {
  assert.equal(
    stripTracking('https://example.com/p?utm_source=a&utm_medium=b&id=5&fbclid=x&gclid=y'),
    'https://example.com/p?id=5',
  );
  assert.equal(stripTracking('https://example.com/p?utm_campaign=z'), 'https://example.com/p');
  assert.equal(stripTracking('https://example.com/p?a=1'), 'https://example.com/p?a=1');
  assert.equal(stripTracking('nope'), 'nope');
});

// ---- lib/util.js ----

test('parseJsonLines handles for(;;); prefix and multi-line bodies', () => {
  assert.deepEqual(parseJsonLines('for (;;);{"a":1}'), [{ a: 1 }]);
  assert.deepEqual(parseJsonLines('{"a":1}\n{"b":2}\n\nnot json\n{"c":3}'), [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.deepEqual(parseJsonLines('for (;;);{"a":1}\n{"b":2}'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseJsonLines('[1,2]'), [[1, 2]]);
  assert.deepEqual(parseJsonLines(''), []);
});

test('walkJson visits every object/array, can skip subtrees and survives cycles', () => {
  const root = { a: { collated_results: [{ id: 1 }, { id: 2 }] }, b: [{ skip: true, inner: { id: 3 } }] };
  root.self = root;
  const ids = [];
  walkJson(root, (node) => {
    if (node && node.skip) return false;
    if (node && typeof node.id === 'number') ids.push(node.id);
    return undefined;
  });
  assert.deepEqual(ids, [1, 2]);

  let count = 0;
  walkJson([{ x: [1, { y: {} }] }], () => {
    count++;
  });
  // [root array], {x}, [1,{y}], {y}, {} -> 5 nodes
  assert.equal(count, 5);
});

test('toIsoDate converts seconds, ms, numeric strings and date strings', () => {
  assert.equal(toIsoDate(1700000000), '2023-11-14');
  assert.equal(toIsoDate(1700000000000), '2023-11-14');
  assert.equal(toIsoDate('1700000000'), '2023-11-14');
  assert.equal(toIsoDate('2024-05-01T10:00:00Z'), '2024-05-01');
  assert.equal(toIsoDate('2024-05-01'), '2024-05-01');
  assert.equal(toIsoDate(''), null);
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate('garbage'), null);
  assert.equal(toIsoDate({}), null);
});

test('uniq and pick', () => {
  assert.deepEqual(uniq(['a', '', 'b', 'a', null, 'c', 'b']), ['a', 'b', 'c']);
  const obj = { advertiser: { name: '' }, adv_name: 'Nike', videos: [{ cover_img: 'https://x/c.jpg' }] };
  assert.equal(pick(obj, ['advertiser.name', 'adv_name']), 'Nike');
  assert.equal(pick(obj, ['videos.0.cover_img']), 'https://x/c.jpg');
  assert.equal(pick(obj, ['missing.path']), undefined);
});

test('sleep resolves and rejects with AbortError on abort; withTimeout falls back', async () => {
  await sleep(1);
  const ac = new AbortController();
  const p = sleep(10000, ac.signal);
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  const slow = new Promise((r) => setTimeout(() => r('late'), 200));
  assert.equal(await withTimeout(slow, 5, 'fallback'), 'fallback');
  assert.equal(await withTimeout(Promise.resolve('fast'), 1000, 'fallback'), 'fast');
});

// ---- lib/html.js ----

test('decodeEntities and stripTags', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;&#66;'), 'a & b <c> "d" \'e\' AB');
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  assert.equal(
    stripTags('<div><script>var x = "<b>";</script><style>.a{}</style><p>Hello&nbsp;<b>big</b>\n world</p></div>'),
    'Hello big world',
  );
});

test('attrValues and extractHrefs decode values with both quote styles', () => {
  const html = `<a href="https://a.com/?x=1&amp;y=2">A</a><a class='c' href='/rel'>B</a><img src="https://img/1.png"><a name="n">C</a>`;
  assert.deepEqual(extractHrefs(html), ['https://a.com/?x=1&y=2', '/rel']);
  assert.deepEqual(attrValues(html, 'img', 'src'), ['https://img/1.png']);
});

test('splitByClass and firstClassText', () => {
  const html =
    '<ul><li class="search-result-item foo"><a href="/ad-library/detail/1">x</a><div class="headline"><span>Nike</span> <div>Inc</div></div></li>' +
    '<li class="bar search-result-item"><a href="/ad-library/detail/2">y</a></li></ul>';
  const chunks = splitByClass(html, 'search-result-item');
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].startsWith('<li class="search-result-item foo">'));
  assert.ok(chunks[0].includes('/ad-library/detail/1'));
  assert.ok(!chunks[0].includes('/ad-library/detail/2'));
  assert.ok(chunks[1].includes('/ad-library/detail/2'));
  assert.equal(firstClassText(html, 'headline'), 'Nike Inc');
  assert.equal(firstClassText(html, 'missing'), '');
});

// ---- lib/model.js ----

test('factories fill defaults', () => {
  assert.deepEqual(PLATFORM_ORDER, ['google', 'meta', 'tiktok', 'linkedin', 'bing', 'snap']);
  const ad = makeAd({ platform: 'meta', id: '1' });
  assert.equal(ad.match, 'keyword');
  assert.equal(ad.source, 'native');
  assert.equal(ad.firstShown, null);
  assert.equal(ad.isActive, null);
  assert.deepEqual(ad.placements, []);
  assert.equal(ad.title, '');
  const adv = makeAdvertiser({ id: 'x' });
  assert.equal(adv.adCount, 0);
  assert.equal(adv.totalAds, null);
  const res = makeResult({ id: 'google', label: 'Google', coverage: 'Global' }, { status: 'empty' });
  assert.equal(res.platform, 'google');
  assert.equal(res.status, 'empty');
  assert.deepEqual(res.stats, { requests: 0, ms: 0 });
  assert.deepEqual(res.ads, []);
});

test('aggregateAdvertisers groups, names and orders by confirmed then total', () => {
  const ads = [
    makeAd({ platform: 'meta', id: '1', advertiserId: 'A', advertiserName: 'Alpha', match: 'keyword' }),
    makeAd({ platform: 'meta', id: '2', advertiserId: 'A', advertiserName: 'Alpha', match: 'keyword' }),
    makeAd({ platform: 'meta', id: '3', advertiserId: 'A', advertiserName: 'Alpha Old', match: 'keyword' }),
    makeAd({ platform: 'meta', id: '4', advertiserId: 'B', advertiserName: 'Beta', match: 'confirmed' }),
    makeAd({ platform: 'meta', id: '5', advertiserId: '', advertiserName: 'Gamma', match: 'confirmed' }),
    makeAd({ platform: 'meta', id: '6', advertiserId: '', advertiserName: 'Gamma', match: 'keyword' }),
  ];
  const advs = aggregateAdvertisers(ads, { platform: 'meta', urlFor: (id, name) => `https://x/${id || name}` });
  assert.deepEqual(
    advs.map((a) => [a.name, a.adCount, a.confirmedCount]),
    [
      ['Gamma', 2, 1],
      ['Beta', 1, 1],
      ['Alpha', 3, 0],
    ],
  );
  assert.equal(advs[1].url, 'https://x/B');
  assert.equal(advs[1].platform, 'meta');
});

test('promoteAdvertiserMatches and dedupeAds', () => {
  const ads = [
    makeAd({ platform: 'tiktok', id: '1', advertiserId: 'A', match: 'confirmed' }),
    makeAd({ platform: 'tiktok', id: '2', advertiserId: 'A', match: 'keyword' }),
    makeAd({ platform: 'tiktok', id: '3', advertiserId: 'A', match: 'name' }),
    makeAd({ platform: 'tiktok', id: '4', advertiserId: 'B', match: 'keyword' }),
  ];
  promoteAdvertiserMatches(ads);
  assert.deepEqual(
    ads.map((a) => a.match),
    ['confirmed', 'advertiser', 'advertiser', 'keyword'],
  );

  const deduped = dedupeAds([
    makeAd({ platform: 'google', id: 'CR1', match: 'keyword', placements: ['youtube'] }),
    makeAd({ platform: 'google', id: 'CR1', match: 'confirmed', placements: [] }),
    makeAd({ platform: 'meta', id: 'CR1', match: 'keyword' }),
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].match, 'confirmed');
  assert.deepEqual(deduped[0].placements, ['youtube']);
});
