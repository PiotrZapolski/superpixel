// Tag signature table for layer A (spec 3.5).
//
// Each signature:
//   platform  display name, also the key used in seeds.ids
//   category  'ads' | 'analytics' | 'tag-manager' | 'crm'
//   patterns  [{re, idGroup?, where:'url'|'html'|'any', context?, fmt?}]
//             re       RegExp without the g flag (detect.js compiles a global copy)
//             idGroup  capture group holding the account id (undefined = presence only)
//             where    'url' = resource URLs (plus script/img src found in html),
//                      'html' = page html split into script blocks + the rest,
//                      'any' = both
//             context  RegExp that must also match the same url / script block.
//                      Patterns with a context only match inside <script> blocks
//                      (never in body text), which is what keeps GA4 from false hits.
//             fmt      optional id normaliser (e.g. numeric conversion id -> AW-...)
//   globals   window names whose presence (probe globals.present) proves the tag
//   idGlobal  optional key in probe globals holding extracted ids

// Delimiter before a query parameter, tolerant of html-escaped '&amp;'.
const Q = '(?:[^"\'\\s<>]*?[&;])?';

function re(src, flags = '') {
  return new RegExp(src, flags);
}

const GTAG_CONTEXT = /gtag\s*\(|googletagmanager/;

export const CATEGORY_ORDER = ['ads', 'analytics', 'tag-manager', 'crm'];

export const SIGNATURES = [
  // ---------------------------------------------------------------- ads
  {
    platform: 'Meta Pixel',
    category: 'ads',
    patterns: [
      { re: /connect\.facebook\.net\/signals\/config\/(\d{10,20})/, idGroup: 1, where: 'any' },
      { re: re('facebook\\.com/tr/?\\?' + Q + 'id=(\\d{10,20})'), idGroup: 1, where: 'any' },
      { re: /fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})/, idGroup: 1, where: 'html' },
      { re: /connect\.facebook\.net\/[a-zA-Z_]+\/fbevents\.js/, where: 'any' },
    ],
    globals: ['fbq'],
    idGlobal: 'fbPixelIds',
  },
  {
    platform: 'Google Ads',
    category: 'ads',
    patterns: [
      { re: /\b(AW-\d{6,12})\b/, idGroup: 1, where: 'any' },
      {
        re: /googleads\.g\.doubleclick\.net\/pagead\/(?:viewthrough)?conversion\/(\d{6,12})/,
        idGroup: 1,
        where: 'any',
        fmt: (id) => 'AW-' + id,
      },
      {
        re: /googleadservices\.com\/pagead\/conversion\/(\d{6,12})/,
        idGroup: 1,
        where: 'any',
        fmt: (id) => 'AW-' + id,
      },
    ],
    globals: [],
  },
  {
    platform: 'Google Floodlight',
    category: 'ads',
    patterns: [
      { re: /\b(DC-\d{6,10})\b/, idGroup: 1, where: 'any' },
      { re: /fls\.doubleclick\.net\/activityi?;src=(\d{6,10})/, idGroup: 1, where: 'any', fmt: (id) => 'DC-' + id },
      { re: /fls\.doubleclick\.net/, where: 'any' },
    ],
    globals: [],
  },
  {
    platform: 'LinkedIn Insight',
    category: 'ads',
    patterns: [
      { re: /_linkedin_partner_id\s*=\s*["']?(\d{3,10})/, idGroup: 1, where: 'html' },
      { re: /_linkedin_data_partner_ids\.push\(\s*["']?(\d{3,10})/, idGroup: 1, where: 'html' },
      { re: re('px\\.ads\\.linkedin\\.com/collect/?\\?' + Q + 'pid=(\\d{3,10})'), idGroup: 1, where: 'any' },
      { re: /snap\.licdn\.com\/li\.lms-analytics/, where: 'any' },
    ],
    globals: [],
    idGlobal: 'linkedinPartnerIds',
  },
  {
    platform: 'TikTok Pixel',
    category: 'ads',
    patterns: [
      { re: /analytics\.tiktok\.com\/i18n\/pixel\/events\.js\?sdkid=([A-Z0-9]{15,25})/, idGroup: 1, where: 'any' },
      { re: /ttq\.load\(\s*['"]([A-Z0-9]{15,25})/, idGroup: 1, where: 'html' },
      { re: /sdkid=([A-Z0-9]{15,25})/, idGroup: 1, where: 'any' },
      { re: /analytics\.tiktok\.com\/i18n\/pixel/, where: 'any' },
    ],
    globals: ['ttq'],
    idGlobal: 'ttqIds',
  },
  {
    platform: 'X (Twitter) Pixel',
    category: 'ads',
    patterns: [
      { re: /twq\(\s*['"](?:config|init)['"]\s*,\s*['"]([a-z0-9]{4,10})/, idGroup: 1, where: 'html' },
      { re: /static\.ads-twitter\.com\/uwt\.js/, where: 'any' },
      { re: re('analytics\\.twitter\\.com/i/adsct\\?' + Q + 'txn_id=([a-z0-9]+)'), idGroup: 1, where: 'any' },
    ],
    globals: ['twq'],
  },
  {
    platform: 'Pinterest Tag',
    category: 'ads',
    patterns: [
      { re: /pintrk\(\s*['"]load['"]\s*,\s*['"](\d{10,16})/, idGroup: 1, where: 'html' },
      { re: re('ct\\.pinterest\\.com/v3/?\\?' + Q + 'tid=(\\d{10,16})'), idGroup: 1, where: 'any' },
      { re: /s\.pinimg\.com\/ct\/core\.js/, where: 'any' },
    ],
    globals: ['pintrk'],
  },
  {
    platform: 'Snap Pixel',
    category: 'ads',
    patterns: [
      { re: /snaptr\(\s*['"]init['"]\s*,\s*['"]([0-9a-f-]{36})/, idGroup: 1, where: 'html' },
      { re: /tr\.snapchat\.com/, where: 'any' },
      { re: /sc-static\.net\/scevent\.min\.js/, where: 'any' },
    ],
    globals: ['snaptr'],
  },
  {
    platform: 'Reddit Pixel',
    category: 'ads',
    patterns: [
      { re: /rdt\(\s*['"]init['"]\s*,\s*['"]((?:t2_|a2_)?[a-z0-9_]{5,20})/, idGroup: 1, where: 'html' },
      { re: /alb\.reddit\.com/, where: 'any' },
      { re: /redditstatic\.com\/ads\/pixel\.js/, where: 'any' },
    ],
    globals: ['rdt'],
  },
  {
    platform: 'Microsoft UET',
    category: 'ads',
    patterns: [
      { re: re('bat\\.bing\\.com/action/0\\?' + Q + 'ti=(\\d{4,12})'), idGroup: 1, where: 'any' },
      { re: /\bti\s*:\s*["'](\d{4,12})["']/, idGroup: 1, where: 'html', context: /uetq|bat\.bing\.com/ },
      { re: /bat\.bing\.com\/bat\.js/, where: 'any' },
    ],
    globals: ['uetq'],
  },
  {
    platform: 'Quora Pixel',
    category: 'ads',
    patterns: [
      { re: /qp\(\s*['"]init['"]\s*,\s*['"]([0-9a-f]{32})/, idGroup: 1, where: 'html' },
      { re: /q\.quora\.com\/_\/ad\//, where: 'any' },
    ],
    globals: ['qp'],
  },
  {
    platform: 'Taboola',
    category: 'ads',
    patterns: [
      { re: /trc\.taboola\.com\/(\d{5,8})\//, idGroup: 1, where: 'any' },
      { re: /cdn\.taboola\.com\/libtrc\/unip\/(\d{5,8})\//, idGroup: 1, where: 'any' },
      { re: /_tfa\.push\(\{[^}]*id:\s*(\d{5,8})/, idGroup: 1, where: 'html' },
    ],
    globals: ['_tfa'],
  },
  {
    platform: 'Outbrain',
    category: 'ads',
    patterns: [
      { re: /amplify\.outbrain\.com\/cp\/obtp\.js/, where: 'any' },
      { re: /OB_ADV_ID\s*=\s*['"]([0-9a-f]{20,40})/, idGroup: 1, where: 'html' },
    ],
    globals: ['obApi'],
  },
  {
    platform: 'Criteo',
    category: 'ads',
    patterns: [
      { re: /static\.criteo\.net\/js\/ld\/ld\.js/, where: 'any' },
      { re: /\baccount\s*:\s*(\d{3,7})/, idGroup: 1, where: 'html', context: /criteo_q/ },
    ],
    globals: ['criteo_q'],
  },
  {
    platform: 'Amazon Ads',
    category: 'ads',
    patterns: [
      { re: re('s\\.amazon-adsystem\\.com/iu3\\?' + Q + 'pid=([a-z0-9-]+)'), idGroup: 1, where: 'any' },
      { re: /amazon-adsystem\.com/, where: 'any' },
    ],
    globals: [],
  },
  {
    platform: 'AdRoll',
    category: 'ads',
    patterns: [
      { re: /adroll_adv_id\s*=\s*["']([A-Z0-9]{20,26})/, idGroup: 1, where: 'html' },
      { re: /adroll_pix_id\s*=\s*["']([A-Z0-9]{20,26})/, idGroup: 1, where: 'html' },
    ],
    globals: [],
    idGlobal: 'adroll',
  },

  // ---------------------------------------------------------- analytics
  {
    platform: 'Google Analytics 4',
    category: 'analytics',
    patterns: [
      // Hits in urls: collect?v=2&tid=G-... or gtag/js?id=G-...
      { re: /[?&;]tid=(G-[A-Z0-9]{6,12})\b/, idGroup: 1, where: 'any' },
      { re: re('googletagmanager\\.com/gtag/js\\?' + Q + 'id=(G-[A-Z0-9]{6,12})\\b'), idGroup: 1, where: 'any' },
      // Bare G- ids only inside a script block that also uses gtag / googletagmanager.
      { re: /\b(G-[A-Z0-9]{6,12})\b/, idGroup: 1, where: 'html', context: GTAG_CONTEXT },
    ],
    globals: [],
  },
  {
    platform: 'Universal Analytics',
    category: 'analytics',
    patterns: [{ re: /\b(UA-\d{4,10}-\d{1,4})\b/, idGroup: 1, where: 'any' }],
    globals: [],
  },
  {
    platform: 'Microsoft Clarity',
    category: 'analytics',
    patterns: [
      { re: /clarity\.ms\/tag\/([a-z0-9]{8,12})/, idGroup: 1, where: 'any' },
      {
        re: /["']clarity["']\s*,\s*["']script["']\s*,\s*["']([a-z0-9]{8,12})["']/,
        idGroup: 1,
        where: 'html',
      },
    ],
    globals: ['clarity'],
  },
  {
    platform: 'Hotjar',
    category: 'analytics',
    patterns: [
      { re: /static\.hotjar\.com\/c\/hotjar-(\d{5,9})\.js/, idGroup: 1, where: 'any' },
      { re: /hjid\s*:\s*(\d{5,9})/, idGroup: 1, where: 'html' },
    ],
    globals: [],
    idGlobal: 'hotjarId',
  },
  {
    platform: 'Yandex Metrica',
    category: 'analytics',
    patterns: [
      { re: /mc\.yandex\.ru\/watch\/(\d{5,10})/, idGroup: 1, where: 'any' },
      { re: /ym\(\s*(\d{5,10})\s*,\s*['"]init/, idGroup: 1, where: 'html' },
      { re: /mc\.yandex\.ru\/metrika\/tag\.js/, where: 'any' },
    ],
    globals: ['ym'],
  },

  // -------------------------------------------------------- tag-manager
  {
    platform: 'Google Tag Manager',
    category: 'tag-manager',
    patterns: [{ re: /\b(GTM-[A-Z0-9]{4,10})\b/, idGroup: 1, where: 'any' }],
    globals: [],
  },

  // ---------------------------------------------------------------- crm
  {
    platform: 'HubSpot',
    category: 'crm',
    patterns: [
      { re: /js\.hs-scripts\.com\/(\d{4,10})\.js/, idGroup: 1, where: 'any' },
      { re: /js\.hs-analytics\.net\/analytics\/\d+\/(\d{4,10})\.js/, idGroup: 1, where: 'any' },
    ],
    globals: ['_hsq'],
  },
  {
    platform: 'Klaviyo',
    category: 'crm',
    patterns: [
      { re: /static\.klaviyo\.com\/onsite\/js\/klaviyo\.js\?company_id=([A-Za-z0-9]{6})/, idGroup: 1, where: 'any' },
    ],
    globals: ['klaviyo'],
  },
];

// Google container keys from window.google_tag_manager, routed by prefix.
export const GOOGLE_KEY_ROUTES = [
  { re: /^GTM-[A-Z0-9]{4,10}$/, platform: 'Google Tag Manager' },
  { re: /^G-[A-Z0-9]{6,12}$/, platform: 'Google Analytics 4' },
  { re: /^AW-\d{6,12}$/, platform: 'Google Ads' },
  { re: /^UA-\d{4,10}-\d{1,4}$/, platform: 'Universal Analytics' },
  { re: /^DC-\d{6,10}$/, platform: 'Google Floodlight' },
];

// Validators for ids read from probe globals (reject junk values).
export const GLOBAL_ID_FORMATS = {
  fbPixelIds: /^\d{6,20}$/,
  ttqIds: /^[A-Z0-9]{15,25}$/i,
  linkedinPartnerIds: /^\d{3,10}$/,
  hotjarId: /^\d{5,9}$/,
  adroll: /^[A-Z0-9]{20,26}$/i,
};
