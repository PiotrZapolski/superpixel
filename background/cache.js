// TTL cache in chrome.storage.local, keys prefixed with "cache:".
const PREFIX = 'cache:';

/**
 * @param {string} key
 * @returns {Promise<any|null>} the cached value or null when missing / expired
 */
export async function get(key) {
  const k = PREFIX + key;
  try {
    const data = await chrome.storage.local.get(k);
    const entry = data[k];
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.expires !== 'number' || entry.expires <= Date.now()) {
      chrome.storage.local.remove(k).catch(() => {});
      return null;
    }
    return entry.value === undefined ? null : entry.value;
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {any} value
 * @param {number} hours
 */
export async function set(key, value, hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return;
  try {
    await chrome.storage.local.set({ [PREFIX + key]: { value, expires: Date.now() + h * 3600 * 1000, at: Date.now() } });
  } catch {
    // quota or serialization errors are not fatal
  }
}

export async function clear() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch {
    // ignore
  }
}
