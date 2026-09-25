// Generic helpers. Pure functions, no chrome.* usage (tested under Node).

function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Promise-based sleep. Rejects with an Error named 'AbortError' when the signal aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    let onAbort = null;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms || 0));
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Resolve to fallbackValue if `promise` does not settle within ms. Rejections propagate.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallbackValue
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, fallbackValue) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallbackValue), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Iterative DFS over objects/arrays. visit(node, key, parent) is called for every object/array
 * node (root included). Returning false skips descending into that node. Cycle-safe, max 200k nodes.
 * @param {any} root
 * @param {(node:any, key:string|number|null, parent:any)=>any} visit
 */
export function walkJson(root, visit) {
  if (root === null || typeof root !== 'object') return;
  const seen = new WeakSet();
  const stack = [[root, null, null]];
  let count = 0;
  while (stack.length) {
    const [node, key, parent] = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    if (++count > 200000) return;
    if (visit(node, key, parent) === false) continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const v = node[i];
        if (v !== null && typeof v === 'object') stack.push([v, i, node]);
      }
    } else {
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) {
        const v = node[keys[i]];
        if (v !== null && typeof v === 'object') stack.push([v, keys[i], node]);
      }
    }
  }
}

function stripXssiPrefix(s) {
  let t = s.replace(/^\s+/, '');
  while (t.startsWith('for (;;);') || t.startsWith('for(;;);')) {
    t = t.slice(t.indexOf(';;);') + 4).replace(/^\s+/, '');
  }
  return t;
}

/**
 * Parse a body that is either one JSON document or newline-separated JSON documents,
 * optionally prefixed with "for (;;);". Unparseable lines are skipped.
 * @param {string} text
 * @returns {any[]}
 */
export function parseJsonLines(text) {
  if (typeof text !== 'string' || !text) return [];
  const body = stripXssiPrefix(text);
  if (!body) return [];
  try {
    return [JSON.parse(body)];
  } catch {
    // fall through to line-by-line parsing
  }
  const out = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = stripXssiPrefix(raw).trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return out;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Convert epoch seconds / ms (number or numeric string) or a date string to 'YYYY-MM-DD'.
 * @param {any} v
 * @returns {string|null}
 */
export function toIsoDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  }
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) n = Number(v);
  if (n !== null) {
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n < 1e11 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Deduplicate preserving order, dropping falsy values.
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
export function uniq(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * First value that is not undefined/null/'' among dotted paths ('a.b', 'videos.0.cover_img').
 * @param {any} obj
 * @param {string[]} paths
 * @returns {any}
 */
export function pick(obj, paths) {
  if (obj == null || !Array.isArray(paths)) return undefined;
  for (const p of paths) {
    let cur = obj;
    for (const part of String(p).split('.')) {
      if (cur == null || typeof cur !== 'object') {
        cur = undefined;
        break;
      }
      cur = cur[part];
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}
