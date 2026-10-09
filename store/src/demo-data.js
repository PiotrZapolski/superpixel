// Demo scan for the store screenshots. Fictional brand and domain (acme-outdoor.com), demo IDs.
// Shapes follow lib/model.js (TagHit, Seeds, PlatformResult, Ad, Advertiser) and the messages
// background/scan.js sends to the side panel. Classic script: sets window.SUPERPIXEL_DEMO.
(function () {
  const D = 'acme-outdoor.com';
  const GAT = 'https://adstransparency.google.com';
  const THUMB = (n) => location.origin + '/store/src/thumbs/' + n + '.svg';

  const tags = [
    { platform: 'Google Tag Manager', category: 'tag-manager', ids: ['GTM-DEMO123'], evidence: ['gtm.js?id=GTM-DEMO123'], source: 'page' },
    { platform: 'Google Analytics 4', category: 'analytics', ids: ['G-DEMO12345'], evidence: ['gtag config G-DEMO12345'], source: 'page' },
    { platform: 'Hotjar', category: 'analytics', ids: ['1234567'], evidence: ['static.hotjar.com hjid'], source: 'page' },
    { platform: 'Google Ads', category: 'ads', ids: ['AW-1234567890'], evidence: ['gtag config AW-1234567890'], source: 'page' },
    { platform: 'Meta Pixel', category: 'ads', ids: ['1234567890123456'], evidence: ["fbq('init')"], source: 'page' },
    { platform: 'TikTok Pixel', category: 'ads', ids: ['CDEMO12345ABCDE67890'], evidence: ['Google tag GTM-DEMO123'], source: 'container' },
    { platform: 'LinkedIn Insight', category: 'ads', ids: ['1234567'], evidence: ['_linkedin_partner_id'], source: 'page' },
    { platform: 'Microsoft UET', category: 'ads', ids: ['12345678'], evidence: ['bat.bing.com ti'], source: 'page' },
    { platform: 'HubSpot', category: 'crm', ids: ['1234567'], evidence: ['js.hs-scripts.com'], source: 'page' },
  ];

  const seeds = {
    domain: D,
    brand: 'Acme Outdoor',
    brandCandidates: ['Acme Outdoor', 'ACME'],
    advertiserNames: ['Acme Outdoor GmbH', 'Acme Outdoor'],
    social: {
      instagram: ['https://www.instagram.com/acmeoutdoor'],
      facebook: [],
      linkedin: [],
      tiktok: [],
      youtube: ['https://www.youtube.com/@acmeoutdoor'],
      x: [],
      pinterest: [],
    },
    ids: {},
  };

  function ad(p) {
    return Object.assign({
      id: '', advertiserId: '', advertiserName: '', format: '', title: '', text: '', landingUrl: '',
      displayUrl: '', firstShown: null, lastShown: null, isActive: null, previewUrl: '', detailUrl: '',
      placements: [], match: 'keyword', source: 'native',
    }, p);
  }

  const G1 = 'AR01234567890123456789';
  const G2 = 'AR09876543210987654321';
  const G3 = 'AR05555555555555555555';
  const google = {
    platform: 'google',
    label: 'Google Ads (Search, YouTube, Display)',
    coverage: 'Global',
    status: 'ok',
    message: '',
    deepLinks: [
      { label: 'Google Ads Transparency', url: GAT + '/?region=anywhere&domain=' + D },
      { label: 'YouTube ads', url: GAT + '/?region=anywhere&domain=' + D + '&platform=YOUTUBE' },
    ],
    advertisers: [
      { platform: 'google', id: G1, name: 'Acme Outdoor GmbH', url: GAT + '/advertiser/' + G1, country: 'DE', adCount: 4, confirmedCount: 4, totalAds: '48', role: 'primary', domains: 1, note: 'Only advertises this domain' },
      { platform: 'google', id: G2, name: 'Trailhead Deals Ltd', url: GAT + '/advertiser/' + G2, country: 'GB', adCount: 1, confirmedCount: 1, totalAds: '320', role: 'other', domains: 14, note: 'Shared account: ads for 14 different sites' },
      { platform: 'google', id: G3, name: 'Summit Gear Co', url: GAT + '/advertiser/' + G3, country: 'US', adCount: 1, confirmedCount: 0, totalAds: '75', role: 'mention', domains: null, note: '' },
    ],
    ads: [
      ad({ platform: 'google', id: 'CR1', advertiserId: G1, advertiserName: 'Acme Outdoor GmbH', format: 'text', title: 'Acme Outdoor - Tents & Trail Gear', text: 'Free shipping over 50 EUR. Lightweight tents, packs and jackets for every season.', displayUrl: D, landingUrl: 'https://' + D + '/tents', firstShown: '2025-03-14', lastShown: '2026-10-08', placements: ['search'], match: 'confirmed', detailUrl: GAT + '/advertiser/' + G1 + '/creative/CR1' }),
      ad({ platform: 'google', id: 'CR2', advertiserId: G1, advertiserName: 'Acme Outdoor GmbH', format: 'video', title: 'Built for the long trail', previewUrl: THUMB('trail'), displayUrl: D, landingUrl: 'https://' + D + '/', firstShown: '2026-05-02', lastShown: '2026-10-07', placements: ['youtube'], match: 'confirmed', detailUrl: GAT + '/advertiser/' + G1 + '/creative/CR2' }),
      ad({ platform: 'google', id: 'CR3', advertiserId: G1, advertiserName: 'Acme Outdoor GmbH', format: 'image', title: 'Autumn sale: up to 30% off', previewUrl: THUMB('sale'), displayUrl: D, landingUrl: 'https://' + D + '/sale', firstShown: '2026-09-15', lastShown: '2026-10-08', match: 'confirmed', detailUrl: GAT + '/advertiser/' + G1 + '/creative/CR3' }),
      ad({ platform: 'google', id: 'CR4', advertiserId: G1, advertiserName: 'Acme Outdoor GmbH', format: 'text', title: 'Acme Outdoor Rain Jackets', text: 'Waterproof, breathable, 3-year warranty.', displayUrl: D + '/jackets', landingUrl: 'https://' + D + '/jackets', firstShown: '2026-01-20', lastShown: '2026-10-06', placements: ['search'], match: 'confirmed', detailUrl: GAT + '/advertiser/' + G1 + '/creative/CR4' }),
      ad({ platform: 'google', id: 'CR5', advertiserId: G2, advertiserName: 'Trailhead Deals Ltd', format: 'text', title: 'Acme Outdoor Tents - Compare Prices', text: 'Best deals on Acme Outdoor tents today.', displayUrl: D, landingUrl: 'https://' + D + '/?ref=trailhead', firstShown: '2026-08-01', lastShown: '2026-10-05', placements: ['search'], match: 'confirmed' }),
      ad({ platform: 'google', id: 'CR6', advertiserId: G3, advertiserName: 'Summit Gear Co', format: 'text', title: 'Better than Acme Outdoor? Try Summit', text: 'Ultralight tents from 129 EUR.', displayUrl: 'summitgear.example', landingUrl: 'https://summitgear.example/', firstShown: '2026-07-11', lastShown: '2026-10-08', placements: ['search'], match: 'keyword' }),
    ],
    summary: { primary: 1, other: 1, mention: 1, sharedAccounts: 1 },
    stats: { requests: 7, ms: 6400 },
  };

  const M1 = '102938475610293';
  const meta = {
    platform: 'meta',
    label: 'Meta (Facebook, Instagram, Messenger)',
    coverage: 'Global (active ads); inactive only EU/political',
    status: 'ok',
    message: '',
    deepLinks: [
      { label: 'Meta Ad Library (domain)', url: 'https://www.facebook.com/ads/library/?q=' + D },
      { label: 'Meta Ad Library ("Acme Outdoor")', url: 'https://www.facebook.com/ads/library/?q=Acme%20Outdoor' },
    ],
    advertisers: [
      { platform: 'meta', id: M1, name: 'Acme Outdoor', url: 'https://www.facebook.com/' + M1, country: 'DE', adCount: 4, confirmedCount: 3, totalAds: null, role: 'primary', domains: null, note: '' },
    ],
    ads: [
      ad({ platform: 'meta', id: 'M1', advertiserId: M1, advertiserName: 'Acme Outdoor', format: 'video', title: 'Pack light. Go further.', text: 'The new Ridge 2 tent weighs just 1.4 kg. Shop now at acme-outdoor.com', previewUrl: THUMB('tent'), displayUrl: D, landingUrl: 'https://' + D + '/ridge-2', firstShown: '2026-08-21', isActive: true, placements: ['facebook', 'instagram'], match: 'confirmed', detailUrl: 'https://www.facebook.com/ads/library/?id=1' }),
      ad({ platform: 'meta', id: 'M2', advertiserId: M1, advertiserName: 'Acme Outdoor', format: 'image', title: 'Autumn sale is on', text: 'Up to 30% off jackets and packs.', previewUrl: THUMB('sale'), displayUrl: D, landingUrl: 'https://' + D + '/sale', firstShown: '2026-09-15', isActive: true, placements: ['facebook', 'instagram', 'messenger'], match: 'confirmed', detailUrl: 'https://www.facebook.com/ads/library/?id=2' }),
      ad({ platform: 'meta', id: 'M3', advertiserId: M1, advertiserName: 'Acme Outdoor', format: 'carousel', title: 'New season, new trails', previewUrl: THUMB('trail'), displayUrl: D, landingUrl: 'https://' + D + '/new', firstShown: '2026-09-02', isActive: true, placements: ['instagram'], match: 'confirmed', detailUrl: 'https://www.facebook.com/ads/library/?id=3' }),
      ad({ platform: 'meta', id: 'M4', advertiserId: M1, advertiserName: 'Acme Outdoor', format: 'image', title: 'Meet us at the Alpine Expo', text: 'Booth 4B, 12-14 October.', displayUrl: 'alpine-expo.example', landingUrl: 'https://alpine-expo.example/', firstShown: '2026-09-28', isActive: true, placements: ['facebook'], match: 'advertiser', detailUrl: 'https://www.facebook.com/ads/library/?id=4' }),
    ],
    summary: { primary: 1, other: 0, mention: 0, sharedAccounts: 0 },
    stats: { requests: 4, ms: 9100 },
  };

  const tiktok = {
    platform: 'tiktok',
    label: 'TikTok',
    coverage: 'EU/EEA, UK, CH only',
    status: 'ok',
    message: '',
    deepLinks: [{ label: 'TikTok Ad Library', url: 'https://library.tiktok.com/ads?region=all&adv_name=Acme%20Outdoor' }],
    advertisers: [
      { platform: 'tiktok', id: '7301234567890123456', name: 'Acme Outdoor', url: '', country: 'DE', adCount: 1, confirmedCount: 1, totalAds: null, role: 'primary', domains: null, note: '' },
    ],
    ads: [
      ad({ platform: 'tiktok', id: 'T1', advertiserId: '7301234567890123456', advertiserName: 'Acme Outdoor', format: 'video', title: 'Pitching the Ridge 2 in 60 seconds', previewUrl: THUMB('tent'), landingUrl: 'https://' + D + '/ridge-2', displayUrl: D, firstShown: '2026-08-30', lastShown: '2026-10-07', match: 'confirmed', detailUrl: 'https://library.tiktok.com/ads/detail/?ad_id=1' }),
    ],
    summary: { primary: 1, other: 0, mention: 0, sharedAccounts: 0 },
    stats: { requests: 5, ms: 14200 },
  };

  const linkedin = {
    platform: 'linkedin',
    label: 'LinkedIn',
    coverage: 'Global, last 12 months',
    status: 'ok',
    message: '',
    deepLinks: [{ label: 'LinkedIn Ad Library', url: 'https://www.linkedin.com/ad-library/search?accountOwner=Acme%20Outdoor' }],
    advertisers: [
      { platform: 'linkedin', id: '12345678', name: 'Acme Outdoor', url: '', country: '', adCount: 2, confirmedCount: 0, totalAds: null, role: 'primary', domains: null, note: '' },
    ],
    ads: [
      ad({ platform: 'linkedin', id: 'L1', advertiserId: '12345678', advertiserName: 'Acme Outdoor', format: 'image', title: 'We are hiring: Head of E-commerce', previewUrl: THUMB('trail'), firstShown: '2026-06-03', match: 'name', detailUrl: 'https://www.linkedin.com/ad-library/detail/1' }),
      ad({ platform: 'linkedin', id: 'L2', advertiserId: '12345678', advertiserName: 'Acme Outdoor', format: 'text', title: 'Gear up your team for the outdoors', firstShown: '2026-04-18', match: 'name', detailUrl: 'https://www.linkedin.com/ad-library/detail/2' }),
    ],
    summary: { primary: 1, other: 0, mention: 0, sharedAccounts: 0 },
    stats: { requests: 3, ms: 7300 },
  };

  const bing = {
    platform: 'bing',
    label: 'Microsoft Advertising (Bing)',
    coverage: 'EU/EEA-served ads',
    status: 'ok',
    message: '',
    deepLinks: [{ label: 'Microsoft Ad Library', url: 'https://adlibrary.ads.microsoft.com/?searchText=Acme%20Outdoor' }],
    advertisers: [
      { platform: 'bing', id: 'BA-102938', name: 'Acme Outdoor GmbH', url: '', country: 'DE', adCount: 3, confirmedCount: 2, totalAds: null, role: 'primary', domains: null, note: '' },
    ],
    ads: [
      ad({ platform: 'bing', id: 'B1', advertiserId: 'BA-102938', advertiserName: 'Acme Outdoor GmbH', format: 'text', title: 'Acme Outdoor Official Store', text: 'Tents, packs and jackets. Free returns.', displayUrl: D, landingUrl: 'https://' + D + '/', firstShown: '2026-02-10', lastShown: '2026-10-01', match: 'confirmed' }),
      ad({ platform: 'bing', id: 'B2', advertiserId: 'BA-102938', advertiserName: 'Acme Outdoor GmbH', format: 'text', title: 'Lightweight Tents from 99 EUR', text: 'Ridge 2: 1.4 kg, 3-season.', displayUrl: D + '/tents', landingUrl: 'https://' + D + '/tents', firstShown: '2026-05-22', lastShown: '2026-10-01', match: 'confirmed' }),
      ad({ platform: 'bing', id: 'B3', advertiserId: 'BA-102938', advertiserName: 'Acme Outdoor GmbH', format: 'text', title: 'Outdoor Gear Outlet', text: 'Last season, best prices.', displayUrl: 'outlet.example', landingUrl: 'https://outlet.example/', firstShown: '2026-06-14', lastShown: '2026-09-20', match: 'advertiser' }),
    ],
    summary: { primary: 1, other: 0, mention: 0, sharedAccounts: 0 },
    stats: { requests: 3, ms: 5200 },
  };

  const snap = {
    platform: 'snap',
    label: 'Snapchat',
    coverage: 'EU only',
    status: 'empty',
    message: '',
    deepLinks: [{ label: 'Snapchat Ads Gallery', url: 'https://adsgallery.snap.com/' }],
    advertisers: [],
    ads: [],
    stats: { requests: 2, ms: 3100 },
  };

  const manual = [
    { id: 'x', label: 'X (Twitter)', coverage: 'EU only', handle: '', url: 'https://ads.x.com/ads-repository', hint: "X builds a CSV report per handle; open and search for the brand's X handle" },
    { id: 'pinterest', label: 'Pinterest', coverage: 'EU only', url: 'https://ads.pinterest.com/ads-repository/', hint: 'Filter by advertiser name Acme Outdoor' },
    { id: 'apple', label: 'Apple App Store', coverage: 'EU only', url: 'https://adrepository.apple.com/', hint: 'Only App Store app ads; search the developer name' },
  ];

  const results = [google, meta, tiktok, linkedin, bing, snap];

  let totalAds = 0;
  let confirmedAds = 0;
  for (const r of results) {
    totalAds += r.ads.length;
    confirmedAds += r.ads.filter((a) => a.match === 'confirmed').length;
  }

  // Same order of messages as background/scan.js sends them.
  const messages = [
    { type: 'phase', text: 'Loading ' + D + ' to read its tags' },
    { type: 'tags', tags, seeds },
    { type: 'manual', libraries: manual },
    { type: 'phase', text: 'Searching ad libraries' },
  ];
  for (const r of results) {
    messages.push({ type: 'platformStart', id: r.platform, label: r.label, coverage: r.coverage });
  }
  for (const r of results) {
    if (r.platform === 'tiktok') messages.push({ type: 'seeds', seeds });
    messages.push({ type: 'platform', result: r });
  }
  messages.push({
    type: 'done',
    summary: { domain: D, tags: tags.length, totalAds, confirmedAds, platforms: results.length, ms: 41000, stopped: false },
  });

  window.SUPERPIXEL_DEMO = {
    domain: D,
    settings: {
      platforms: { google: true, meta: true, tiktok: true, linkedin: true, bing: true, snap: true },
      maxPagesGoogle: 5, metaScrolls: 2, metaExpandPages: 3, tiktokRegions: ['DE', 'FR', 'PL'],
      tiktokDetails: 8, linkedinDetails: 10, linkedinPages: 2, bingAdvertisers: 6, cacheHours: 24,
      searchapiKey: '', useSearchapiFallback: false, showScanTabs: false, remoteLog: false,
    },
    messages,
    // The stored scan as the panel exports it (lastData): {domain, at, tags, seeds, results, manual}.
    scan: { domain: D, at: '2026-10-09T09:41:00.000Z', tags, seeds, results, manual },
  };
})();
