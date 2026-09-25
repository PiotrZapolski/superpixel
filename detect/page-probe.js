// Injected with chrome.scripting.executeScript({world:'MAIN', func: probe}).
// The function is serialized, so it must be fully self-contained: no imports,
// no references to module scope, no closures over outer variables.

export function probe() {
  var HTML_LIMIT = 1.5 * 1024 * 1024;
  var MAX_URLS = 3000;
  var w = window;
  var out = {
    url: '',
    title: '',
    html: '',
    resourceUrls: [],
    globals: {
      googleTagManagerKeys: [],
      fbPixelIds: [],
      ttqIds: [],
      linkedinPartnerIds: [],
      hotjarId: null,
      adroll: { adv: null, pix: null },
      dataLayerLength: 0,
      present: {},
    },
    meta: { ogSiteName: '', ogTitle: '', applicationName: '', jsonLd: [] },
  };

  function pushUnique(arr, v) {
    try {
      if (v === undefined || v === null) return;
      var s = String(v).trim();
      if (s && arr.indexOf(s) === -1) arr.push(s);
    } catch (e) {}
  }

  try { out.url = String(location.href); } catch (e) {}
  try { out.title = String(document.title || ''); } catch (e) {}
  try {
    var html = document.documentElement ? document.documentElement.outerHTML : '';
    out.html = html.length > HTML_LIMIT ? html.slice(0, HTML_LIMIT) : html;
  } catch (e) {}

  // ---- resource urls
  try {
    var seen = new Set();
    var addUrl = function (u) {
      try {
        if (out.resourceUrls.length >= MAX_URLS) return;
        if (typeof u !== 'string' || !/^https?:\/\//i.test(u) || seen.has(u)) return;
        seen.add(u);
        out.resourceUrls.push(u.length > 2000 ? u.slice(0, 2000) : u);
      } catch (e) {}
    };
    try {
      var entries = performance.getEntriesByType('resource') || [];
      for (var i = 0; i < entries.length; i++) addUrl(entries[i] && entries[i].name);
    } catch (e) {}
    try {
      var scripts = document.scripts || [];
      for (var j = 0; j < scripts.length; j++) addUrl(scripts[j] && scripts[j].src);
    } catch (e) {}
    try {
      var imgs = document.querySelectorAll('img[src]');
      for (var k = 0; k < imgs.length; k++) addUrl(imgs[k] && imgs[k].src);
    } catch (e) {}
  } catch (e) {}

  // ---- google_tag_manager container keys
  try {
    var gtm = w.google_tag_manager;
    if (gtm && typeof gtm === 'object') {
      var keys = Object.keys(gtm);
      for (var a = 0; a < keys.length; a++) {
        if (/^(GTM|G|AW|UA|DC)-[A-Z0-9-]+$/.test(keys[a])) pushUnique(out.globals.googleTagManagerKeys, keys[a]);
      }
    }
  } catch (e) {}

  // ---- dataLayer
  try {
    var dl = w.dataLayer;
    if (dl && typeof dl.length === 'number') out.globals.dataLayerLength = dl.length;
  } catch (e) {}

  // ---- Meta pixel ids
  try {
    var fbq = w.fbq;
    if (fbq && typeof fbq.getState === 'function') {
      var st = fbq.getState();
      var px = (st && st.pixels) || [];
      for (var b = 0; b < px.length; b++) pushUnique(out.globals.fbPixelIds, px[b] && px[b].id);
    }
  } catch (e) {}
  try {
    var inst = (w._fbq && w._fbq.instance) || (w.fbq && w.fbq.instance);
    var byId = inst && inst.pixelsByID;
    if (byId && typeof byId === 'object') {
      var pk = Object.keys(byId);
      for (var c = 0; c < pk.length; c++) pushUnique(out.globals.fbPixelIds, pk[c]);
    }
  } catch (e) {}

  // ---- TikTok
  try {
    var ttq = w.ttq;
    if (ttq && ttq._i && typeof ttq._i === 'object') {
      var tk = Object.keys(ttq._i);
      for (var d = 0; d < tk.length; d++) pushUnique(out.globals.ttqIds, tk[d]);
    }
  } catch (e) {}

  // ---- LinkedIn
  try {
    if (w._linkedin_partner_id !== undefined) pushUnique(out.globals.linkedinPartnerIds, w._linkedin_partner_id);
  } catch (e) {}
  try {
    var lids = w._linkedin_data_partner_ids;
    if (lids && typeof lids.length === 'number') {
      for (var f = 0; f < lids.length && f < 50; f++) pushUnique(out.globals.linkedinPartnerIds, lids[f]);
    }
  } catch (e) {}

  // ---- Hotjar
  try {
    var hjs = w._hjSettings;
    if (hjs && hjs.hjid !== undefined && hjs.hjid !== null) out.globals.hotjarId = String(hjs.hjid);
  } catch (e) {}

  // ---- AdRoll
  try { if (w.adroll_adv_id) out.globals.adroll.adv = String(w.adroll_adv_id); } catch (e) {}
  try { if (w.adroll_pix_id) out.globals.adroll.pix = String(w.adroll_pix_id); } catch (e) {}

  // ---- presence flags
  var names = ['uetq', 'twq', 'pintrk', 'snaptr', 'rdt', 'qp', '_tfa', 'obApi', 'criteo_q', '_hsq',
    'clarity', 'ym', 'dataLayer', 'gtag', 'ttq'];
  for (var n = 0; n < names.length; n++) {
    try { out.globals.present[names[n]] = w[names[n]] !== undefined && w[names[n]] !== null; } catch (e) {
      out.globals.present[names[n]] = false;
    }
  }
  try { out.globals.present.fbq = !!(w.fbq || w._fbq); } catch (e) { out.globals.present.fbq = false; }
  try { out.globals.present.klaviyo = !!(w.klaviyo || w._learnq); } catch (e) { out.globals.present.klaviyo = false; }

  // ---- meta tags + JSON-LD
  function metaAttr(sel) {
    try {
      var el = document.querySelector(sel);
      return el ? String(el.getAttribute('content') || '').trim() : '';
    } catch (e) {
      return '';
    }
  }
  out.meta.ogSiteName = metaAttr('meta[property="og:site_name"]');
  out.meta.ogTitle = metaAttr('meta[property="og:title"]');
  out.meta.applicationName = metaAttr('meta[name="application-name"]');
  try {
    var lds = document.querySelectorAll('script[type="application/ld+json"]');
    for (var q = 0; q < lds.length && q < 20; q++) {
      try {
        var txt = String(lds[q].textContent || '');
        if (txt.trim()) out.meta.jsonLd.push(txt.length > 100000 ? txt.slice(0, 100000) : txt);
      } catch (e) {}
    }
  } catch (e) {}

  return out;
}
