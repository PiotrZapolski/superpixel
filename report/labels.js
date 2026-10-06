// Label dictionaries for the social graphic (PL default, EN). Pure, no DOM (tested under Node).
// The report page UI itself stays in English like the side panel; only the graphic is bilingual.

export const LANGS = ['en', 'pl'];
export const DEFAULT_LANG = 'en';

const MONTHS = {
  pl: ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

/**
 * Polish plural form: 1 reklama, 2-4 reklamy (not 12-14), else reklam.
 * @param {number} n
 * @param {string} one
 * @param {string} few
 * @param {string} many
 * @returns {string}
 */
export function plPlural(n, one, few, many) {
  const a = Math.abs(Math.trunc(Number(n) || 0));
  if (a === 1) return one;
  const d = a % 10;
  const dd = a % 100;
  if (d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14)) return few;
  return many;
}

function enPlural(n, one, many) {
  return Math.abs(Number(n) || 0) === 1 ? one : many;
}

const DICT = {
  pl: {
    subtitle: 'Reklamy i tagi marketingowe',
    heroTotal: (n) => plPlural(n, 'reklama w publicznych bibliotekach', 'reklamy w publicznych bibliotekach', 'reklam w publicznych bibliotekach'),
    heroConfirmed: (n) => plPlural(n, 'reklama linkuje do domeny', 'reklamy linkują do domeny', 'reklam linkuje do domeny'),
    heroSub: (n) => `w tym ${n} ${plPlural(n, 'potwierdzona', 'potwierdzone', 'potwierdzonych')}`,
    barsTitle: 'Reklamy wg platformy',
    legendConfirmed: 'linkują do domeny',
    legendOther: 'pozostałe dopasowania',
    tagsTitle: 'Tagi na stronie',
    noAds: 'Nie znaleziono reklam w bibliotekach',
    noTags: 'Nie wykryto tagów',
    more: (n) => `+${n} więcej`,
    factOldest: (d) => `Najstarsza reklama: start ${d}`,
    factNewest: (d) => `Najnowsza reklama: start ${d}`,
    factTopAdvertiser: (name, n) => `Główny reklamodawca: ${name} (${n} ${plPlural(n, 'reklama', 'reklamy', 'reklam')})`,
    factFormats: (list) => `Formaty: ${list}`,
    factPlacements: (list) => `Miejsca emisji: ${list}`,
    factCountries: (list) => `Kraje reklamodawców: ${list}`,
    scanned: (d) => `Skan: ${d}`,
    formats: { video: 'wideo', image: 'obraz', text: 'tekst', carousel: 'karuzela' },
  },
  en: {
    subtitle: 'Ads and marketing tags',
    heroTotal: (n) => enPlural(n, 'ad in public ad libraries', 'ads in public ad libraries'),
    heroConfirmed: (n) => enPlural(n, 'ad links to the domain', 'ads link to the domain'),
    heroSub: (n) => `${n} confirmed`,
    barsTitle: 'Ads by platform',
    legendConfirmed: 'link to the domain',
    legendOther: 'other matches',
    tagsTitle: 'Tags on the site',
    noAds: 'No ads found in the libraries',
    noTags: 'No tags detected',
    more: (n) => `+${n} more`,
    factOldest: (d) => `Oldest ad first shown ${d}`,
    factNewest: (d) => `Newest ad first shown ${d}`,
    factTopAdvertiser: (name, n) => `Top advertiser: ${name} (${n} ${enPlural(n, 'ad', 'ads')})`,
    factFormats: (list) => `Formats: ${list}`,
    factPlacements: (list) => `Placements: ${list}`,
    factCountries: (list) => `Advertiser countries: ${list}`,
    scanned: (d) => `Scanned ${d}`,
    formats: { video: 'video', image: 'image', text: 'text', carousel: 'carousel' },
  },
};

/**
 * Dictionary for a language, falling back to English.
 * @param {string} lang
 */
export function labels(lang) {
  return DICT[lang] || DICT[DEFAULT_LANG];
}

/**
 * 'YYYY-MM-DD' (or anything Date can parse) as "5 paź 2026" / "5 Oct 2026"; '' when invalid.
 * @param {string} value
 * @param {string} lang
 * @returns {string}
 */
export function formatDate(value, lang) {
  if (!value) return '';
  const s = String(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  let y;
  let m;
  let d;
  if (iso && !/T/.test(s)) {
    y = Number(iso[1]);
    m = Number(iso[2]) - 1;
    d = Number(iso[3]);
  } else {
    const t = new Date(s);
    if (Number.isNaN(t.getTime())) return '';
    y = t.getFullYear();
    m = t.getMonth();
    d = t.getDate();
  }
  if (!(m >= 0 && m <= 11) || !d) return '';
  const months = MONTHS[lang] || MONTHS[DEFAULT_LANG];
  return `${d} ${months[m]} ${y}`;
}

/**
 * Ad format label for the graphic: known formats translated, others kept as-is.
 * @param {string} format
 * @param {string} lang
 * @returns {string}
 */
export function formatName(format, lang) {
  const k = String(format || '').trim().toLowerCase();
  return labels(lang).formats[k] || k;
}
