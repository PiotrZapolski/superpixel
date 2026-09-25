// Per-key throttle and backoff helpers.
import { sleep } from '../lib/util.js';

const BACKOFF_MS = [3000, 10000, 30000];

/**
 * Create a throttle that spaces calls at least minIntervalMs apart. Concurrent callers are
 * queued (each reserves the next slot).
 * @param {number} minIntervalMs
 * @returns {(signal?:AbortSignal)=>Promise<void>}
 */
export function createThrottle(minIntervalMs) {
  let nextAt = 0;
  return async function throttle(signal) {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + Math.max(0, minIntervalMs || 0);
    const wait = at - now;
    if (wait > 0) await sleep(wait, signal);
    else if (signal && signal.aborted) await sleep(0, signal);
  };
}

const registry = new Map();

/**
 * Shared throttle per key (first registration wins the interval).
 * @param {string} key
 * @param {number} ms
 */
export function getThrottle(key, ms) {
  let t = registry.get(key);
  if (!t) {
    t = createThrottle(ms);
    registry.set(key, t);
  }
  return t;
}

/**
 * Backoff delay for a 0-based retry attempt: 3s, 10s, 30s (clamped).
 * @param {number} attempt
 * @returns {number}
 */
export function backoff(attempt) {
  const i = Math.min(Math.max(0, Math.floor(attempt || 0)), BACKOFF_MS.length - 1);
  return BACKOFF_MS[i];
}
