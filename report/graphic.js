// Canvas 2D drawing of the social graphic. Thin on purpose: all positions, sizes and texts come
// from layoutGraphic() (report/layout.js), this file only paints them. Text and shapes only, so the
// canvas never gets tainted and toBlob() always works.

import { FONT_FAMILY, getPreset, layoutGraphic } from './layout.js';

export const ACCENT = '#f97316';

export const THEMES = {
  dark: {
    bg: '#0c0a09',
    bg2: '#1c1310',
    ink: '#fafaf9',
    muted: '#a8a29e',
    track: '#292524',
    chipBg: '#1c1917',
    chipBorder: '#44403c',
    rule: '#292524',
    accent: ACCENT,
  },
  light: {
    bg: '#ffffff',
    bg2: '#fff4ec',
    ink: '#1c1917',
    muted: '#57534e',
    track: '#e7e5e4',
    chipBg: '#fafaf9',
    chipBorder: '#d6d3d1',
    rule: '#e7e5e4',
    accent: '#ea580c',
  },
};

function font(size, weight) {
  return `${weight} ${size}px ${FONT_FAMILY}`;
}

/** measure(text, size, weight) backed by a 2D context, for layoutGraphic(). */
export function canvasMeasure(ctx) {
  return (text, size, weight) => {
    ctx.font = font(size, weight);
    return ctx.measureText(String(text || '')).width;
  };
}

function drawText(ctx, item, color) {
  if (!item || !item.text) return;
  ctx.font = font(item.size, item.weight);
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.textAlign = item.align === 'right' ? 'right' : 'left';
  ctx.fillText(item.text, item.x, item.y);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/**
 * Draw the graphic onto `canvas`, resizing it to the preset.
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<import('./summary.js').graphicModel>} model
 * @param {{preset:string, theme:'dark'|'light'}} opts
 */
export function drawGraphic(canvas, model, { preset, theme }) {
  const p = getPreset(preset);
  const T = THEMES[theme] || THEMES.dark;
  canvas.width = p.w;
  canvas.height = p.h;
  const ctx = canvas.getContext('2d');
  const L = layoutGraphic(model, p.id, canvasMeasure(ctx));
  const u = L.u;

  // Background with a soft accent glow in the top right corner.
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, p.w, p.h);
  const glow = ctx.createRadialGradient(p.w, 0, 0, p.w, 0, Math.max(p.w, p.h) * 0.8);
  glow.addColorStop(0, T.bg2);
  glow.addColorStop(1, T.bg);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, p.w, p.h);
  ctx.fillStyle = T.accent;
  ctx.fillRect(0, 0, p.w, Math.round(10 * u));

  drawText(ctx, L.title, T.ink);
  drawText(ctx, L.subtitle, T.muted);
  drawText(ctx, L.hero, T.accent);
  drawText(ctx, L.heroLabel, T.ink);
  drawText(ctx, L.heroSub, T.muted);

  drawText(ctx, L.barsTitle, T.muted);
  for (const item of L.legend || []) {
    ctx.globalAlpha = item.swatch.alpha;
    ctx.fillStyle = T.accent;
    roundRect(ctx, item.swatch.x, item.swatch.y, item.swatch.size, item.swatch.size, 3 * u);
    ctx.fill();
    ctx.globalAlpha = 1;
    drawText(ctx, item.text, T.muted);
  }
  for (const row of L.bars.rows) {
    ctx.fillStyle = row.color;
    ctx.beginPath();
    ctx.arc(row.dot.x, row.dot.y, row.dot.r, 0, Math.PI * 2);
    ctx.fill();
    drawText(ctx, row.name, T.ink);
    const b = row.bar;
    const r = b.h / 2;
    ctx.fillStyle = T.track;
    roundRect(ctx, b.x, b.y, b.w, b.h, r);
    ctx.fill();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = T.accent;
    roundRect(ctx, b.x, b.y, b.fillW, b.h, r);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (b.confirmedW) {
      roundRect(ctx, b.x, b.y, b.confirmedW, b.h, r);
      ctx.fill();
    }
    drawText(ctx, row.value, T.ink);
  }
  drawText(ctx, L.bars.more, T.muted);
  drawText(ctx, L.bars.empty, T.muted);

  drawText(ctx, L.chips.title, T.muted);
  for (const ch of L.chips.chips) {
    roundRect(ctx, ch.x, ch.y, ch.w, ch.h, ch.h / 2);
    ctx.fillStyle = T.chipBg;
    ctx.fill();
    ctx.lineWidth = Math.max(1, 2 * u);
    ctx.strokeStyle = ch.more ? T.accent : T.chipBorder;
    ctx.stroke();
    ctx.font = font(ch.size, 600);
    ctx.fillStyle = ch.more ? T.accent : T.ink;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(ch.text, ch.x + ch.w / 2, ch.y + ch.h / 2 + 1);
  }
  drawText(ctx, L.chips.empty, T.muted);

  for (const f of L.facts) {
    ctx.fillStyle = T.accent;
    ctx.fillRect(f.x - Math.round(18 * u), f.y + Math.round(f.size * 0.35), Math.round(8 * u), Math.round(8 * u));
    drawText(ctx, f, T.ink);
  }

  ctx.fillStyle = T.rule;
  ctx.fillRect(L.rule.x, L.rule.y, L.rule.w, Math.max(1, Math.round(2 * u)));
  drawText(ctx, L.footer.brand, T.accent);
  drawText(ctx, L.footer.date, T.muted);
  return L;
}

/** PNG blob of the canvas. */
export function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not render PNG'))), 'image/png');
  });
}
