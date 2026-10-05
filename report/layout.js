// Layout math for the social graphic: presets, font sizes, truncation and how many items fit.
// Pure, no DOM (tested under Node). Text width comes from an injected measure(text, size, weight)
// callback: the page passes one backed by CanvasRenderingContext2D.measureText, tests pass a
// character-count approximation. Every text item uses textBaseline 'top'; x is the left edge, or
// the right edge when align is 'right'.

export const PRESETS = {
  x: { id: 'x', label: 'X / landscape', w: 1600, h: 900 },
  square: { id: 'square', label: 'Square', w: 1080, h: 1080 },
  portrait: { id: 'portrait', label: 'Portrait (LinkedIn / Instagram)', w: 1080, h: 1350 },
};
export const PRESET_ORDER = ['x', 'square', 'portrait'];
export const DEFAULT_PRESET = 'x';

export const MAX_BARS = 6;
export const MAX_CHIPS = 12;
export const ELLIPSIS = '...';
export const FONT_FAMILY = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// Base sizes in px for a 1080 px short side; scaled by min(w, h) / 1080.
const CONFIG = {
  x: { mode: 'columns', pad: 76, title: 80, titleMin: 40, subtitle: 28, hero: 210, heroLabel: 30, heroSub: 26, section: 24, barLabel: 26, barRow: 54, barThick: 16, chip: 22, chipH: 46, chipRows: 2, fact: 26, factLine: 42, maxFacts: 3, footer: 24, gap: 30 },
  square: { mode: 'stack', pad: 72, title: 72, titleMin: 38, subtitle: 26, hero: 150, heroLabel: 30, heroSub: 24, section: 22, barLabel: 26, barRow: 48, barThick: 14, chip: 21, chipH: 42, chipRows: 2, fact: 25, factLine: 38, maxFacts: 2, footer: 22, gap: 26 },
  portrait: { mode: 'stack', pad: 76, title: 80, titleMin: 40, subtitle: 28, hero: 180, heroLabel: 32, heroSub: 26, section: 24, barLabel: 28, barRow: 58, barThick: 16, chip: 23, chipH: 46, chipRows: 3, fact: 27, factLine: 44, maxFacts: 3, footer: 24, gap: 34 },
};

/** @param {string} id */
export function getPreset(id) {
  return PRESETS[id] || PRESETS[DEFAULT_PRESET];
}

/**
 * Text cut to fit maxWidth, with "..." appended when cut. '' when not even "..." fits.
 * @param {string} text
 * @param {number} maxWidth
 * @param {number} size
 * @param {number} weight
 * @param {(text:string, size:number, weight:number)=>number} measure
 * @returns {string}
 */
export function truncate(text, maxWidth, size, weight, measure) {
  const s = String(text || '');
  if (measure(s, size, weight) <= maxWidth) return s;
  if (measure(ELLIPSIS, size, weight) > maxWidth) return '';
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(s.slice(0, mid).trimEnd() + ELLIPSIS, size, weight) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + ELLIPSIS;
}

/**
 * Largest font size between minSize and size (step 2 px) at which text fits; truncated at
 * minSize when it still does not fit.
 * @returns {{text:string, size:number}}
 */
export function fitText(text, maxWidth, size, minSize, weight, measure) {
  const s = String(text || '');
  let cur = Math.round(size);
  const min = Math.round(Math.min(size, minSize));
  while (cur > min && measure(s, cur, weight) > maxWidth) cur -= 2;
  if (cur < min) cur = min;
  return { text: truncate(s, maxWidth, cur, weight, measure), size: cur };
}

/**
 * Lays out chips left to right in up to maxRows rows. When not all fit, the tail is replaced by a
 * "+N more" chip (N = chips not shown). Labels beyond `cap` count as hidden.
 * @param {string[]} labels
 * @param {{x:number, y:number, maxWidth:number, maxRows:number, size:number, h:number, gap:number,
 *   padX:number, weight?:number, cap?:number, more:(n:number)=>string,
 *   measure:(text:string, size:number, weight:number)=>number}} o
 * @returns {{chips:{text:string, x:number, y:number, w:number, h:number, more:boolean}[], hidden:number, rows:number}}
 */
export function fitChips(labels, o) {
  const weight = o.weight || 600;
  const cap = o.cap == null ? MAX_CHIPS : o.cap;
  const all = (Array.isArray(labels) ? labels : []).map((l) => String(l || '')).filter(Boolean);
  const wanted = all.slice(0, cap);
  const measure = (t) => o.measure(t, o.size, weight);
  const widthOf = (t) => Math.min(o.maxWidth, Math.ceil(measure(t) + 2 * o.padX));

  // Place chips greedily; returns the placed list.
  const place = (texts) => {
    const out = [];
    let row = 0;
    let cx = 0;
    for (const t of texts) {
      const w = widthOf(t);
      if (cx > 0 && cx + w > o.maxWidth) {
        row++;
        cx = 0;
      }
      if (row >= o.maxRows) break;
      out.push({ text: t, x: o.x + cx, y: o.y + row * (o.h + o.gap), w, h: o.h, more: false, row });
      cx += w + o.gap;
    }
    return out;
  };

  let placed = place(wanted);
  let hidden = all.length - placed.length;
  if (hidden > 0) {
    // Drop chips from the end until the "+N" chip fits after the last one.
    for (;;) {
      const n = all.length - placed.length;
      const moreText = o.more(n);
      const mw = widthOf(moreText);
      const last = placed[placed.length - 1];
      let mx = 0;
      let mrow = 0;
      if (last) {
        mx = last.x - o.x + last.w + o.gap;
        mrow = last.row;
        if (mx + mw > o.maxWidth) {
          mrow++;
          mx = 0;
        }
      }
      if (mrow < o.maxRows) {
        placed.push({ text: moreText, x: o.x + mx, y: o.y + mrow * (o.h + o.gap), w: mw, h: o.h, more: true, row: mrow });
        hidden = n;
        break;
      }
      if (!placed.length) {
        hidden = n;
        break;
      }
      placed = placed.slice(0, -1);
    }
  }
  const rows = placed.length ? Math.max(...placed.map((c) => c.row)) + 1 : 0;
  return { chips: placed.map(({ row, ...c }) => c), hidden, rows };
}

function textItem(text, x, y, size, weight, extra = {}) {
  return { text, x: Math.round(x), y: Math.round(y), size: Math.round(size), weight, ...extra };
}

/**
 * Bars section: rows of [dot][name][bar][value]. Shows up to maxRows rows; when more platforms
 * exist the last row becomes "+N more".
 */
function layoutBars(model, box, c, u, measure) {
  const bars = Array.isArray(model.bars) ? model.bars : [];
  const rowH = c.barRow * u;
  const fit = Math.max(1, Math.min(MAX_BARS, Math.floor(box.h / rowH)));
  const out = { rows: [], more: null, empty: null, maxRows: fit };
  if (!bars.length) {
    out.empty = textItem(truncate(model.noAds, box.w, c.barLabel * u, 500, measure), box.x, box.y + 4 * u, c.barLabel * u, 500);
    return out;
  }
  let shown = bars;
  let hidden = 0;
  if (bars.length > fit) {
    shown = bars.slice(0, Math.max(0, fit - 1));
    hidden = bars.length - shown.length;
  }
  const size = c.barLabel * u;
  const dotR = Math.round(size * 0.28);
  const nameX = box.x + dotR * 2 + 14 * u;
  const maxNameW = Math.max(...shown.map((b) => measure(b.name, size, 600)), 0);
  const nameW = Math.min(maxNameW, box.w * 0.36);
  const valueW = Math.max(...shown.map((b) => measure(String(b.value), size, 800)), 0);
  const barX = nameX + nameW + 20 * u;
  const barRight = box.x + box.w - valueW - 16 * u;
  const barW = Math.max(10, barRight - barX);
  const max = Math.max(...shown.map((b) => b.value), 1);
  const thick = c.barThick * u;
  shown.forEach((b, i) => {
    const rowY = box.y + i * rowH;
    const textY = rowY + (rowH - size) / 2;
    out.rows.push({
      platform: b.platform,
      color: b.color,
      dot: { x: Math.round(box.x + dotR), y: Math.round(rowY + rowH / 2), r: dotR },
      name: textItem(truncate(b.name, nameW, size, 600, measure), nameX, textY, size, 600),
      value: textItem(String(b.value), box.x + box.w, textY, size, 800, { align: 'right' }),
      bar: {
        x: Math.round(barX),
        y: Math.round(rowY + (rowH - thick) / 2),
        w: Math.round(barW),
        h: Math.round(thick),
        fillW: Math.max(Math.round(thick), Math.round((barW * b.value) / max)),
        confirmedW: b.confirmed > 0 ? Math.max(Math.round(thick), Math.round((barW * Math.min(b.confirmed, b.value)) / max)) : 0,
      },
    });
  });
  if (hidden) {
    const y = box.y + shown.length * rowH + (rowH - size) / 2;
    out.more = textItem(model.more(hidden), box.x, y, size * 0.85, 600);
  }
  return out;
}

/** Legend for the bars (solid = links to the domain, faded = other matches), right-aligned. */
function layoutLegend(model, right, y, maxWidth, c, u, measure) {
  if (!model.legendOther || !(model.bars || []).some((b) => b.confirmed < b.value)) return null;
  const size = c.section * u * 0.8;
  const sw = Math.round(size * 0.8);
  const items = [
    { text: model.legendConfirmed, alpha: 1 },
    { text: model.legendOther, alpha: 0.35 },
  ];
  const widths = items.map((it) => sw + 8 * u + measure(it.text, size, 500));
  const total = widths.reduce((a, b) => a + b, 0) + 20 * u;
  if (total > maxWidth) return null;
  let x = right - total;
  return items.map((it, i) => {
    const item = {
      swatch: { x: Math.round(x), y: Math.round(y + (size - sw) / 2), size: sw, alpha: it.alpha },
      text: textItem(it.text, x + sw + 8 * u, y, size, 500),
    };
    x += widths[i] + 20 * u;
    return item;
  });
}

/**
 * Full layout of the graphic for a preset.
 * @param {ReturnType<import('./summary.js').graphicModel>} model
 * @param {string} presetId
 * @param {(text:string, size:number, weight:number)=>number} measure
 */
export function layoutGraphic(model, presetId, measure) {
  const p = getPreset(presetId);
  const c = CONFIG[p.id];
  const u = Math.min(p.w, p.h) / 1080;
  const pad = Math.round(c.pad * u);
  const W = p.w;
  const H = p.h;
  const innerW = W - 2 * pad;
  const gap = c.gap * u;
  const L = { preset: p.id, w: W, h: H, pad, u };

  // Header: title (domain) and subtitle across the full width.
  let y = pad;
  const t = fitText(model.title, innerW, c.title * u, c.titleMin * u, 800, measure);
  L.title = textItem(t.text, pad, y, t.size, 800);
  y += t.size * 1.18;
  L.subtitle = textItem(truncate(model.subtitle, innerW, c.subtitle * u, 500, measure), pad, y, c.subtitle * u, 500);
  y += c.subtitle * u * 1.3 + gap;
  const contentTop = y;

  // Footer: brand left, scan date right, a rule above.
  const footerSize = c.footer * u;
  const footerY = H - pad - footerSize;
  L.rule = { x: pad, y: Math.round(footerY - gap * 0.8), w: innerW };
  L.footer = {
    brand: textItem(model.footerBrand, pad, footerY, footerSize, 800),
    date: model.footerDate
      ? textItem(truncate(model.footerDate, innerW * 0.6, footerSize, 500, measure), W - pad, footerY, footerSize, 500, { align: 'right' })
      : null,
  };
  const contentBottom = L.rule.y - gap;

  const sectionH = c.section * u * 1.7;
  const chipH = c.chipH * u;
  const chipGap = 10 * u;

  const heroBlock = (x, top, maxW, inline) => {
    const heroSize = c.hero * u;
    const heroText = String(model.hero);
    const heroH = heroSize * 0.92;
    const hero = textItem(heroText, x, top, heroSize, 800);
    const labelSize = c.heroLabel * u;
    const subSize = c.heroSub * u;
    let lx = x;
    let ly = top + heroH + 8 * u;
    let lw = maxW;
    if (inline) {
      const nw = measure(heroText, heroSize, 800);
      lx = x + nw + 28 * u;
      lw = x + maxW - lx;
      const textH = labelSize * 1.3 + (model.heroSub ? subSize * 1.3 : 0);
      ly = top + (heroH - textH) / 2;
      if (lw < maxW * 0.35) {
        lx = x;
        lw = maxW;
        ly = top + heroH + 8 * u;
        inline = false;
      }
    }
    const label = textItem(truncate(model.heroLabel, lw, labelSize, 600, measure), lx, ly, labelSize, 600);
    const sub = model.heroSub
      ? textItem(truncate(model.heroSub, lw, subSize, 500, measure), lx, ly + labelSize * 1.3, subSize, 500)
      : null;
    const bottom = inline ? top + heroH : ly + labelSize * 1.3 + (sub ? subSize * 1.3 : 0);
    return { hero, heroLabel: label, heroSub: sub, bottom };
  };

  const factsBlock = (x, top, maxW, bottom, maxFacts) => {
    const size = c.fact * u;
    const lineH = c.factLine * u;
    const room = Math.max(0, Math.floor((bottom - top) / lineH));
    const n = Math.min(maxFacts, room, (model.facts || []).length);
    return (model.facts || []).slice(0, n).map((f, i) => textItem(truncate(f, maxW, size, 500, measure), x, top + i * lineH, size, 500));
  };

  const chipsBlock = (x, top, maxW, rows) => {
    const title = textItem(truncate(model.tagsTitle, maxW, c.section * u, 700, measure), x, top, c.section * u, 700);
    if (!model.chips || !model.chips.length) {
      return { title, chips: [], hidden: 0, rows: 1, empty: textItem(model.noTags, x, top + sectionH, c.chip * u, 500) };
    }
    const fit = fitChips(model.chips, {
      x,
      y: top + sectionH,
      maxWidth: maxW,
      maxRows: rows,
      size: c.chip * u,
      h: chipH,
      gap: chipGap,
      padX: 16 * u,
      more: model.more,
      measure,
    });
    return { title, chips: fit.chips.map((ch) => ({ ...ch, size: Math.round(c.chip * u) })), hidden: fit.hidden, rows: Math.max(1, fit.rows), empty: null };
  };

  const chipsHeight = (rows) => sectionH + rows * chipH + (rows - 1) * chipGap;

  if (c.mode === 'columns') {
    const leftW = Math.round(W * 0.42) - pad;
    const rightX = Math.round(W * 0.48);
    const rightW = W - pad - rightX;
    const h = heroBlock(pad, contentTop, leftW, false);
    Object.assign(L, { hero: h.hero, heroLabel: h.heroLabel, heroSub: h.heroSub });
    L.facts = factsBlock(pad, h.bottom + gap * 1.2, leftW, contentBottom, c.maxFacts);

    L.barsTitle = textItem(truncate(model.barsTitle, rightW * 0.5, c.section * u, 700, measure), rightX, contentTop, c.section * u, 700);
    L.legend = layoutLegend(model, rightX + rightW, contentTop, rightW * 0.5, c, u, measure);
    const chipsTop = contentBottom - chipsHeight(c.chipRows);
    const barsBox = { x: rightX, y: contentTop + sectionH, w: rightW, h: chipsTop - gap - (contentTop + sectionH) };
    L.bars = layoutBars(model, barsBox, c, u, measure);
    // Pull the chips up under the bars when the bars use less room than reserved.
    const usedBars = (L.bars.rows.length + (L.bars.more ? 1 : 0) || 1) * c.barRow * u;
    const chipsY = Math.min(chipsTop, barsBox.y + usedBars + gap);
    L.chips = chipsBlock(rightX, chipsY, rightW, c.chipRows);
    return L;
  }

  // Stack: header, hero (number with label beside it), bars, chips, facts, footer.
  const h = heroBlock(pad, contentTop, innerW, true);
  Object.assign(L, { hero: h.hero, heroLabel: h.heroLabel, heroSub: h.heroSub });
  const barsTitleY = h.bottom + gap;
  L.barsTitle = textItem(truncate(model.barsTitle, innerW * 0.5, c.section * u, 700, measure), pad, barsTitleY, c.section * u, 700);
  L.legend = layoutLegend(model, pad + innerW, barsTitleY, innerW * 0.5, c, u, measure);

  const factsCount = Math.min(c.maxFacts, (model.facts || []).length);
  const factsH = factsCount * c.factLine * u;
  const factsTop = contentBottom - factsH;
  const chipsTop = factsTop - (factsCount ? gap : 0) - chipsHeight(c.chipRows);
  const barsBox = { x: pad, y: barsTitleY + sectionH, w: innerW, h: chipsTop - gap - (barsTitleY + sectionH) };
  L.bars = layoutBars(model, barsBox, c, u, measure);
  const usedBars = (L.bars.rows.length + (L.bars.more ? 1 : 0) || 1) * c.barRow * u;
  const chipsY = Math.min(chipsTop, barsBox.y + usedBars + gap);
  L.chips = chipsBlock(pad, chipsY, innerW, c.chipRows);
  const chipsBottom = chipsY + chipsHeight(L.chips.rows);
  L.facts = factsBlock(pad, Math.min(factsTop, chipsBottom + gap), innerW, contentBottom, c.maxFacts);
  return L;
}

/**
 * Download name: superpixel-<domain>-<preset>-<YYYYMMDD>.png
 * @param {string} domain
 * @param {string} presetId
 * @param {string} at scan date (ISO)
 * @returns {string}
 */
export function graphicFilename(domain, presetId, at) {
  const d = String(domain || 'domain').replace(/[^a-z0-9.-]+/gi, '-');
  let dateStr = 'unknown';
  const t = new Date(at);
  if (at && !Number.isNaN(t.getTime())) {
    dateStr = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
  }
  return `superpixel-${d}-${getPreset(presetId).id}-${dateStr}.png`;
}
