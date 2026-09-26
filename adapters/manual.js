// Ad libraries that cannot be searched automatically (verified 2026-09-26), shown as manual links:
// - X Ads Repository (ads.x.com/ads-repository): no queryable endpoint; the user picks a country
//   and X builds a CSV report per handle asynchronously.
// - Pinterest ads repository: its API (api.pinterest.com/ads/v4/ads_repository/ad_library)
//   ignores advertiser_name / query filters, so it cannot search by brand.
// - Apple Ad Repository: App Store app ads only.
// No fake searches: each entry is a link plus a hint of what to type there.

const X_EXCLUDE = new Set(['intent', 'share', 'home', 'hashtag', 'search', 'i', 'login', 'signup']);

/**
 * X handle from seeds.social.x ('https://x.com/<handle>' urls), '' when none.
 * @param {object} seeds
 * @returns {string}
 */
export function xHandle(seeds) {
  const list = (seeds && seeds.social && Array.isArray(seeds.social.x) && seeds.social.x) || [];
  for (const u of list) {
    const m = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(String(u || '').trim());
    if (m && !X_EXCLUDE.has(m[1].toLowerCase())) return m[1];
  }
  return '';
}

/**
 * @param {object} seeds
 * @returns {{id:string, label:string, coverage:string, handle?:string, url:string, hint:string}[]}
 */
export function manualLibraries(seeds) {
  const brand = String((seeds && (seeds.brand || seeds.domain)) || '').trim();
  const handle = xHandle(seeds);
  return [
    {
      id: 'x',
      label: 'X (Twitter)',
      coverage: 'EU only',
      handle,
      url: 'https://ads.x.com/ads-repository',
      hint: handle
        ? `X builds a CSV report per handle; open and search for @${handle}`
        : 'X builds a CSV report per handle; open and search for the brand\'s X handle',
    },
    {
      id: 'pinterest',
      label: 'Pinterest',
      coverage: 'EU only',
      url: 'https://ads.pinterest.com/ads-repository/',
      hint: brand ? `Filter by advertiser name ${brand}` : 'Filter by advertiser name',
    },
    {
      id: 'apple',
      label: 'Apple App Store',
      coverage: 'EU only',
      url: 'https://adrepository.apple.com/',
      hint: 'Only App Store app ads; search the developer name',
    },
  ];
}
