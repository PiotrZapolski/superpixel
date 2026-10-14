// Small persistent memory across scans (chrome.storage.local): what worked or failed last time,
// so a scan does not repeat a known failure (issues #17 and #36). Every call is guarded: without
// chrome.storage (Node tests) get resolves undefined and set/remove do nothing. Never throws.

function hasStorage() {
  return typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
}

/** {get, set, remove} over chrome.storage.local, the shape adapters get as ctx.memory. */
export const storageMemory = {
  async get(key) {
    if (!hasStorage()) return undefined;
    try {
      const got = await chrome.storage.local.get(key);
      return got ? got[key] : undefined;
    } catch {
      return undefined;
    }
  },
  async set(key, value) {
    if (!hasStorage()) return;
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch {
      // quota or storage errors are not fatal
    }
  },
  async remove(key) {
    if (!hasStorage()) return;
    try {
      await chrome.storage.local.remove(key);
    } catch {
      // ignore
    }
  },
};

/** Guarded read of an injected memory ({get,set,remove} or nothing). */
export async function memGet(memory, key) {
  try {
    return memory && typeof memory.get === 'function' ? await memory.get(key) : undefined;
  } catch {
    return undefined;
  }
}

export async function memSet(memory, key, value) {
  try {
    if (memory && typeof memory.set === 'function') await memory.set(key, value);
  } catch {
    // ignore
  }
}

export async function memRemove(memory, key) {
  try {
    if (memory && typeof memory.remove === 'function') await memory.remove(key);
  } catch {
    // ignore
  }
}
