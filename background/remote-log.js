// Remote debug log (opt-in): ships scan warnings, errors and every platform's final status to
// superpixel.run so broken scrapers can be fixed quickly. Only runs when settings.remoteLog is
// true. Sends nothing beyond the contract: install id, extension version, scan id + domain and
// the selected log entries (which never carry query strings, see safeUrl in log.js).
// Node-safe: everything chrome-specific is optional or injected (tests use createRemoteLog).

import { log, onEntry } from './log.js';
import { loadSettings } from './settings.js';

export const ENDPOINT = 'https://superpixel.run/v1/logs';
// Public by design: it ships inside the extension and only keeps random traffic off the endpoint.
export const INGEST_KEY = 'b56d600c2338204dd6c61771ae0e14f7';
export const SRC = 'remote-log';
export const MAX_BATCH = 500;
export const IDLE_DELAY_MS = 30000;
export const TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 256 * 1024;
const ENTRY_BUDGET_BYTES = MAX_BODY_BYTES - 4096; // room for the envelope
const MAX_MSG = 1000;
const MAX_SCAN_ENTRIES = 5000;
const MAX_IDLE_ENTRIES = 500;
const INSTALL_KEY = 'installId';

function hasStorage() {
  return typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
}

const isProblem = (e) => e.level === 'warn' || e.level === 'error';
const isFinish = (e) => String(e.msg || '').startsWith('Adapter finish');

/**
 * Whether an entry belongs in a remote batch. Inside a scan: warn/error, 'Adapter finish' lines
 * and the scan start/end lines. Outside a scan: warn/error only. Own lines are never shipped.
 * @param {{level:string, src:string, msg:string}} entry
 * @param {boolean} inScan
 * @returns {boolean}
 */
export function isShipped(entry, inScan) {
  if (!entry || typeof entry !== 'object' || entry.src === SRC) return false;
  if (isProblem(entry)) return true;
  if (!inScan) return false;
  if (isFinish(entry)) return true;
  return entry.src === 'scan' && /^Scan (start|end|stopped|failed)\b/.test(String(entry.msg || ''));
}

/**
 * A batch is worth sending when it has a warning/error or at least one platform status.
 * @param {{level:string, msg:string}[]} entries
 * @returns {boolean}
 */
export function worthSending(entries) {
  return (entries || []).some((e) => isProblem(e) || isFinish(e));
}

function byteLength(s) {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return String(s).length * 3;
  }
}

/**
 * Split entries into chunks of at most `max` entries and roughly `budget` bytes of JSON.
 * @param {object[]} entries
 * @param {number} [max]
 * @param {number} [budget]
 * @returns {object[][]}
 */
export function chunkEntries(entries, max = MAX_BATCH, budget = ENTRY_BUDGET_BYTES) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const e of entries || []) {
    const n = byteLength(JSON.stringify(e)) + 1;
    if (cur.length && (cur.length >= max || size + n > budget)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** @returns {string} timestamp + random, unique enough to group one scan's batches */
export function newScanId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function randomUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

let installIdPromise = null;

/**
 * Random install id, created once and persisted in chrome.storage.local ('installId').
 * Without chrome.storage it lives in memory for the process (tests).
 * @returns {Promise<string>}
 */
export function getInstallId() {
  if (installIdPromise) return installIdPromise;
  installIdPromise = (async () => {
    if (!hasStorage()) return randomUuid();
    try {
      const got = await chrome.storage.local.get(INSTALL_KEY);
      const stored = got && got[INSTALL_KEY];
      if (typeof stored === 'string' && stored) return stored;
      const id = randomUuid();
      await chrome.storage.local.set({ [INSTALL_KEY]: id });
      return id;
    } catch {
      return randomUuid();
    }
  })();
  return installIdPromise;
}

function manifestVersion() {
  try {
    return chrome.runtime.getManifest().version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function cleanEntry(e) {
  return {
    t: String(e.t || new Date().toISOString()),
    level: e.level === 'warn' || e.level === 'error' ? e.level : 'info',
    src: String(e.src || 'sw'),
    msg: String(e.msg === undefined ? '' : e.msg).slice(0, MAX_MSG),
  };
}

/**
 * Remote log shipper. All dependencies are injectable so it runs in node tests without chrome.
 * @param {{
 *   fetch?: typeof fetch,
 *   getConsent?: () => Promise<boolean>|boolean,
 *   getInstallId?: () => Promise<string>|string,
 *   version?: string|(() => string),
 *   log?: (level:string, src:string, msg:string) => void,
 *   idleDelayMs?: number,
 * }} [deps]
 */
export function createRemoteLog(deps = {}) {
  const fetchFn = deps.fetch || ((...a) => globalThis.fetch(...a));
  const getConsent = deps.getConsent || (() => false);
  const installIdFn = deps.getInstallId || getInstallId;
  const versionOf = () => (typeof deps.version === 'function' ? deps.version() : deps.version || '0.0.0');
  const logFn = deps.log || (() => {});
  const idleDelayMs = Number.isFinite(deps.idleDelayMs) ? deps.idleDelayMs : IDLE_DELAY_MS;

  let consent = null; // cached value, gates buffering outside a scan
  let scan = null; // {id, domain, entries}
  let idle = [];
  let idleTimer = null;

  function clearIdle() {
    idle = [];
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  async function consentNow() {
    try {
      consent = (await getConsent()) === true;
    } catch {
      consent = false;
    }
    return consent;
  }

  async function post(body) {
    let signal;
    let timer = null;
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(TIMEOUT_MS);
    } else if (typeof AbortController !== 'undefined') {
      const c = new AbortController();
      timer = setTimeout(() => c.abort(), TIMEOUT_MS);
      signal = c.signal;
    }
    try {
      const res = await fetchFn(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Superpixel-Key': INGEST_KEY },
        body,
        credentials: 'omit',
        signal,
      });
      const status = res && Number(res.status);
      if (!(status >= 200 && status < 300)) throw new Error(`HTTP ${status || 'no response'}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Send entries (chunked) if consent is granted. Never throws; one failure drops the batch.
   * @returns {Promise<boolean>} true when every chunk was accepted
   */
  async function send(scanMeta, entries) {
    try {
      if (!entries.length || !(await consentNow())) return false;
      const install = String(await installIdFn());
      const version = String(versionOf());
      for (const chunk of chunkEntries(entries)) {
        await post(JSON.stringify({ install, version, scan: scanMeta, entries: chunk }));
      }
      return true;
    } catch (e) {
      try {
        // src SRC is ignored by handle(), so this line never loops back into a batch.
        logFn('info', SRC, `Send failed, batch dropped: ${(e && e.message) || e}`);
      } catch {
        // ignore
      }
      return false;
    }
  }

  function flushIdle() {
    const entries = idle;
    clearIdle();
    return send(null, entries);
  }

  return {
    /** Feed one log entry (wired to log.js onEntry). */
    handle(entry) {
      if (scan) {
        if (!isShipped(entry, true)) return;
        scan.entries.push(cleanEntry(entry));
        if (scan.entries.length > MAX_SCAN_ENTRIES) scan.entries.shift();
        return;
      }
      if (consent !== true || !isShipped(entry, false)) return;
      idle.push(cleanEntry(entry));
      if (idle.length > MAX_IDLE_ENTRIES) idle.shift();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        flushIdle();
      }, idleDelayMs);
    },

    /**
     * Start collecting a scan's entries. Returns the scan id.
     * @param {string} domain
     */
    scanStart(domain) {
      scan = { id: newScanId(), domain: String(domain || ''), entries: [] };
      consentNow();
      return scan.id;
    },

    /**
     * End the current scan and ship its batch (if consent and anything worth sending).
     * Synchronously detaches the batch, so a following scanStart never mixes scans.
     * @returns {Promise<boolean>}
     */
    async scanEnd() {
      const s = scan;
      scan = null;
      if (!s || !worthSending(s.entries)) return false;
      return send({ id: s.id, domain: s.domain }, s.entries);
    },

    /** Update the cached consent (after settings load/save). Declining drops any buffer. */
    setConsent(value) {
      consent = value === true;
      if (!consent) clearIdle();
    },

    refreshConsent: consentNow,
    flushIdle,

    /** For tests and debugging. */
    pending() {
      return { scan: scan ? scan.entries.slice() : null, idle: idle.slice() };
    },
  };
}

let instance = null;

/** The service worker's shared instance (chrome-backed, consent from settings.remoteLog). */
export function remoteLog() {
  if (!instance) {
    instance = createRemoteLog({
      getConsent: async () => (await loadSettings()).remoteLog === true,
      version: manifestVersion,
      log,
    });
  }
  return instance;
}

let installed = false;

/** Connect the shared instance to the debug log. Safe to call more than once. */
export function installRemoteLog() {
  const rl = remoteLog();
  if (!installed) {
    installed = true;
    onEntry((e) => rl.handle(e));
    rl.refreshConsent();
  }
  return rl;
}
