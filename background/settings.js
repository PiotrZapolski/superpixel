// Settings: defaults + load/save in chrome.storage.local under "settings".

export const DEFAULT_SETTINGS = Object.freeze({
  platforms: Object.freeze({ google: true, meta: true, tiktok: true, linkedin: true, bing: true, snap: true }),
  maxPagesGoogle: 5,
  metaScrolls: 2,
  metaExpandPages: 3,
  tiktokRegions: Object.freeze(['DE', 'FR', 'GB', 'IT', 'ES', 'NL', 'PL', 'SE']),
  tiktokDetails: 8,
  linkedinDetails: 10,
  linkedinPages: 2,
  bingAdvertisers: 6,
  searchapiKey: '',
  useSearchapiFallback: true,
  showScanTabs: false,
  cacheHours: 24,
});

function merge(base, stored) {
  const out = {
    ...base,
    platforms: { ...base.platforms },
    tiktokRegions: [...base.tiktokRegions],
  };
  if (!stored || typeof stored !== 'object') return out;
  for (const [k, v] of Object.entries(stored)) {
    if (v === undefined) continue;
    if (k === 'platforms') {
      if (v && typeof v === 'object') Object.assign(out.platforms, v);
    } else if (Array.isArray(v)) {
      out[k] = [...v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** @returns {Promise<typeof DEFAULT_SETTINGS>} */
export async function loadSettings() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    return merge(DEFAULT_SETTINGS, settings);
  } catch {
    return merge(DEFAULT_SETTINGS, null);
  }
}

/**
 * Merge partial into the stored settings and persist. Returns the full merged settings.
 * @param {object} partial
 */
export async function saveSettings(partial) {
  const current = await loadSettings();
  const next = merge(current, partial);
  await chrome.storage.local.set({ settings: next });
  return next;
}
