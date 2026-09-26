import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS_LABELS,
  statusChipText,
  matchLabel,
  formatLabel,
  placementsText,
  deepLinkShortLabel,
  headerDeepLinks,
} from '../sidepanel/view.js';

test('statusChipText: confirmed count, else ad count, never "None"', () => {
  const ads = [{ match: 'confirmed' }, { match: 'confirmed' }, { match: 'keyword' }];
  assert.equal(statusChipText({ status: 'ok', ads }), '2 confirmed');
  assert.equal(statusChipText({ status: 'ok', ads: [{ match: 'name' }, { match: 'name' }] }), '2 ads');
  assert.equal(statusChipText({ status: 'ok', ads: [{ match: 'name' }] }), '1 ad');
  assert.equal(statusChipText({ status: 'ok', ads: [] }), 'No ads');
  assert.equal(statusChipText({ status: 'empty', ads: [] }), 'No ads');
  assert.equal(statusChipText({ status: 'needs_user' }), 'Needs you');
  assert.equal(statusChipText({ status: 'rate_limited', ads }), 'Rate limited');
  assert.equal(statusChipText({ status: 'changed' }), 'Changed');
  assert.equal(statusChipText({ status: 'error' }), 'Error');
  assert.equal(statusChipText({ status: 'running' }), 'Running');
  assert.equal(statusChipText({ status: 'skipped' }), 'Skipped');
  assert.ok(!Object.values(STATUS_LABELS).includes('None'));
});

test('matchLabel: human text for every match kind', () => {
  assert.equal(matchLabel('confirmed'), 'Links to domain');
  assert.equal(matchLabel('advertiser'), 'Same advertiser');
  assert.equal(matchLabel('keyword'), 'Mentions');
  assert.equal(matchLabel('name'), 'Name match');
  assert.equal(matchLabel(undefined), 'Mentions');
});

test('formatLabel is empty for missing formats', () => {
  assert.equal(formatLabel({ format: 'image' }), 'image');
  assert.equal(formatLabel({ format: '  ' }), '');
  assert.equal(formatLabel({}), '');
});

test('placementsText: only multi-placement platforms, never the platform name itself', () => {
  assert.equal(placementsText({ platform: 'linkedin', placements: ['linkedin'] }), '');
  assert.equal(placementsText({ platform: 'tiktok', placements: ['tiktok'] }), '');
  assert.equal(placementsText({ platform: 'snap', placements: ['snapchat'] }), '');
  assert.equal(placementsText({ platform: 'meta', placements: ['facebook', 'instagram', 'audience_network'] }), 'Facebook, Instagram, Audience Network');
  assert.equal(placementsText({ platform: 'google', placements: ['youtube'] }), 'YouTube');
  assert.equal(placementsText({ platform: 'google', placements: ['google'] }), '');
  assert.equal(placementsText({ platform: 'meta', placements: [] }), '');
});

test('deepLinkShortLabel derives short visible text from the label', () => {
  assert.equal(deepLinkShortLabel('Google Ads Transparency'), 'Library');
  assert.equal(deepLinkShortLabel('YouTube ads'), 'YouTube');
  assert.equal(deepLinkShortLabel('Meta Ad Library (domain)'), 'Domain');
  assert.equal(deepLinkShortLabel('Meta Ad Library ("Outrank")'), 'Outrank');
  assert.equal(deepLinkShortLabel('LinkedIn Ad Library (company 12345)'), 'Company 12345');
  assert.equal(deepLinkShortLabel('LinkedIn ads of Outrank.so'), 'Outrank.so');
  assert.equal(deepLinkShortLabel('LinkedIn ads of A Very Long Company Name Ltd'), 'A Very Long Com...');
  assert.equal(deepLinkShortLabel(''), 'Library');
});

test('headerDeepLinks: up to 2 links with distinct short labels, null when more', () => {
  const two = headerDeepLinks([
    { label: 'Google Ads Transparency', url: 'https://a' },
    { label: 'YouTube ads', url: 'https://b' },
  ]);
  assert.deepEqual(two.map((l) => [l.short, l.label]), [['Library', 'Google Ads Transparency'], ['YouTube', 'YouTube ads']]);
  const same = headerDeepLinks([{ label: 'Library A', url: 'https://a' }, { label: 'Library B', url: 'https://b' }]);
  assert.deepEqual(same.map((l) => l.short), ['Library', 'Library 2']);
  assert.equal(headerDeepLinks([1, 2, 3].map((i) => ({ label: `L${i}`, url: `https://x/${i}` }))), null);
  assert.deepEqual(headerDeepLinks(undefined), []);
});
