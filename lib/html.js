// Tiny regex-based HTML helpers. No DOMParser: must run in the MV3 service worker and in Node.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Opening tag with attributes; quoted attribute values may contain '>'.
const OPEN_TAG_SRC = '<([a-zA-Z][a-zA-Z0-9-]*)\\b((?:[^>"\']|"[^"]*"|\'[^\']*\')*)>';

const INLINE_TAGS = new Set(['a', 'b', 'i', 'u', 's', 'em', 'strong', 'span', 'small', 'sup', 'sub', 'mark', 'abbr', 'code', 'font']);

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decode named (&amp; &lt; &gt; &quot; &#39; &apos; &nbsp;) and numeric entities.
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  if (typeof s !== 'string' || !s.includes('&')) return s == null ? '' : String(s);
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = NAMED[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/**
 * Remove script/style blocks, comments and tags; decode entities; collapse whitespace.
 * @param {string} s
 * @returns {string}
 */
export function stripTags(s) {
  if (typeof s !== 'string' || !s) return '';
  let t = s
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g, (m, name) =>
    INLINE_TAGS.has(name.toLowerCase()) ? '' : ' ',
  );
  t = t.replace(/<![^>]*>/g, ' ');
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

function attrFrom(attrs, attrName) {
  const re = new RegExp('(?:^|\\s)' + escapeRe(attrName) + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}

/**
 * Decoded values of attrName on every <tagName> tag.
 * @param {string} html
 * @param {string} tagName
 * @param {string} attrName
 * @returns {string[]}
 */
export function attrValues(html, tagName, attrName) {
  if (typeof html !== 'string' || !html) return [];
  const re = new RegExp('<' + escapeRe(tagName) + '\\b((?:[^>"\']|"[^"]*"|\'[^\']*\')*)>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const v = attrFrom(m[1], attrName);
    if (v !== null) out.push(decodeEntities(v));
  }
  return out;
}

/**
 * Decoded href values of all <a> tags.
 * @param {string} html
 * @returns {string[]}
 */
export function extractHrefs(html) {
  return attrValues(html, 'a', 'href');
}

function findClassTags(html, classSubstring) {
  const re = new RegExp(OPEN_TAG_SRC, 'g');
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const cls = attrFrom(m[2], 'class');
    if (cls !== null && cls.includes(classSubstring)) {
      out.push({ index: m.index, end: m.index + m[0].length, tag: m[1].toLowerCase(), raw: m[0] });
    }
  }
  return out;
}

/**
 * Chunks of html, each starting at an opening tag whose class contains classSubstring and running
 * until the next such tag (or the end of the string).
 * @param {string} html
 * @param {string} classSubstring
 * @returns {string[]}
 */
export function splitByClass(html, classSubstring) {
  if (typeof html !== 'string' || !html || !classSubstring) return [];
  const hits = findClassTags(html, classSubstring);
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].index : html.length;
    out.push(html.slice(hits[i].index, end));
  }
  return out;
}

/**
 * Plain text of the inner content of the first element whose class contains classSubstring.
 * @param {string} html
 * @param {string} classSubstring
 * @returns {string}
 */
export function firstClassText(html, classSubstring) {
  if (typeof html !== 'string' || !html || !classSubstring) return '';
  const re = new RegExp(OPEN_TAG_SRC, 'g');
  let m;
  let hit = null;
  while ((m = re.exec(html)) !== null) {
    const cls = attrFrom(m[2], 'class');
    if (cls !== null && cls.includes(classSubstring)) {
      hit = { end: m.index + m[0].length, tag: m[1].toLowerCase(), raw: m[0] };
      break;
    }
  }
  if (!hit) return '';
  if (VOID_TAGS.has(hit.tag) || /\/\s*>$/.test(hit.raw)) return '';
  const tagRe = new RegExp('<(/?)' + escapeRe(hit.tag) + '\\b(?:[^>"\']|"[^"]*"|\'[^\']*\')*>', 'gi');
  tagRe.lastIndex = hit.end;
  let depth = 1;
  let t;
  while ((t = tagRe.exec(html)) !== null) {
    if (t[1] === '/') {
      depth--;
      if (depth === 0) return stripTags(html.slice(hit.end, t.index));
    } else if (!/\/\s*>$/.test(t[0])) {
      depth++;
    }
  }
  return stripTags(html.slice(hit.end));
}
