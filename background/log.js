// Debug log: ring buffer of the last 500 entries, persisted to chrome.storage.local ('debugLog',
// debounced 1s). Warnings and errors are mirrored to the console so they show up under
// chrome://extensions > Errors. Never log query strings (they may carry the SearchAPI key).
// Node-safe: without chrome.storage it only keeps entries in memory (tests).

export const MAX_ENTRIES = 500;
export const STORAGE_KEY = 'debugLog';
const PERSIST_DELAY_MS = 1000;
const MAX_MSG = 1000;
const LEVELS = new Set(['info', 'warn', 'error']);

let entries = [];
let loadPromise = null;
let persistTimer = null;

function hasStorage() {
  return typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
}

/** Load persisted entries once; entries logged before the load finished are kept after them. */
function ensureLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (!hasStorage()) return;
    try {
      const got = await chrome.storage.local.get(STORAGE_KEY);
      const stored = got && Array.isArray(got[STORAGE_KEY]) ? got[STORAGE_KEY] : [];
      entries = stored.concat(entries).slice(-MAX_ENTRIES);
    } catch {
      // storage unavailable: memory only
    }
  })();
  return loadPromise;
}

function schedulePersist() {
  if (!hasStorage() || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    ensureLoaded()
      .then(() => chrome.storage.local.set({ [STORAGE_KEY]: entries }))
      .catch(() => {});
  }, PERSIST_DELAY_MS);
}

/**
 * host + path of a URL, never the query string or fragment.
 * @param {string} url
 * @returns {string}
 */
export function safeUrl(url) {
  try {
    const u = new URL(String(url));
    return u.host + u.pathname;
  } catch {
    return String(url || '').split(/[?#]/)[0].slice(0, 200);
  }
}

/**
 * Error text for the log: message plus the first stack frame.
 * @param {any} e
 * @returns {string}
 */
export function errText(e) {
  if (!e) return 'unknown error';
  const msg = (e && e.message) || String(e);
  const stack = typeof e.stack === 'string' ? e.stack.split('\n').map((l) => l.trim()) : [];
  const frame = stack.find((l) => l.startsWith('at ')) || '';
  return frame ? `${msg} (${frame})` : msg;
}

/**
 * Append a log entry.
 * @param {'info'|'warn'|'error'} level
 * @param {string} src platform id or 'scan' | 'capture' | 'sw'
 * @param {string} msg
 */
export function log(level, src, msg) {
  const lvl = LEVELS.has(level) ? level : 'info';
  const entry = {
    t: new Date().toISOString(),
    level: lvl,
    src: String(src || 'sw'),
    msg: String(msg === undefined ? '' : msg).slice(0, MAX_MSG),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  try {
    if (lvl === 'error') console.error(`[superpixel ${entry.src}] ${entry.msg}`);
    else if (lvl === 'warn') console.warn(`[superpixel ${entry.src}] ${entry.msg}`);
  } catch {
    // no console
  }
  ensureLoaded();
  schedulePersist();
  return entry;
}

export const logInfo = (src, msg) => log('info', src, msg);
export const logWarn = (src, msg) => log('warn', src, msg);
export const logError = (src, msg) => log('error', src, msg);

/** @returns {Promise<{t:string, level:string, src:string, msg:string}[]>} */
export async function getLog() {
  await ensureLoaded();
  return entries.slice();
}

export async function clearLog() {
  await ensureLoaded();
  entries = [];
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (hasStorage()) {
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

/**
 * Plain-text lines: "<time> <LEVEL> [src] msg".
 * @param {{t:string, level:string, src:string, msg:string}[]} list
 * @returns {string[]}
 */
export function formatLogLines(list) {
  return (Array.isArray(list) ? list : []).map(
    (e) => `${e.t} ${String(e.level || 'info').toUpperCase()} [${e.src}] ${e.msg}`,
  );
}
