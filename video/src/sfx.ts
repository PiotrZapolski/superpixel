import {EV} from './events';
import {type SceneId, scene} from './timeline';

// Every sound effect, placed on the animation frames from src/events.ts. The files come
// from the JustRank explainer library (public/sfx). There is no voice, so the effects sit
// about 12 to 16 dB under the music: BASE holds a per-file level that lands each effect
// there (the files differ a lot in loudness), `level` scales one cue relative to that.
// Each cue fades in over 2 frames and out over its last 6, so trimmed files never click.

export type Sound = 'click' | 'pop' | 'whoosh' | 'typing' | 'ding-success' | 'riser-logo' | 'tick-counter' | 'drop-down';

/** Natural length of each file, in frames. */
const LENGTH: Record<Sound, number> = {
	click: 14,
	pop: 14,
	whoosh: 24,
	typing: 60,
	'ding-success': 30,
	'riser-logo': 48,
	'tick-counter': 36,
	'drop-down': 30,
};

/** Linear gain that puts each file about 14 dB under the -14 LUFS soundtrack (measured with volumedetect). */
const BASE: Record<Sound, number> = {
	click: 0.6,
	pop: 0.3,
	whoosh: 0.22,
	typing: 0.8,
	'ding-success': 0.25,
	'riser-logo': 0.14,
	'tick-counter': 0.3,
	'drop-down': 0.12,
};

export const SFX_GAIN = 1;

export type Cue = {sound: Sound; at: number; frames: number; volume: number; label: string; trimBefore?: number};

const cue = (sc: SceneId, local: number, sound: Sound, level: number, label: string, frames?: number): Cue => ({
	sound,
	at: scene(sc).start + local,
	frames: Math.max(4, Math.min(LENGTH[sound], frames ?? LENGTH[sound])),
	volume: BASE[sound] * level,
	label,
});

const whooshInto = (sc: SceneId) => cue(sc, -5, 'whoosh', 0.7, `cut into ${sc}`);

const p = EV.promise;
const tg = EV.tags;
const ad = EV.ads;
const lb = EV.labels;
const ex = EV.export;
const ct = EV.cta;

// The riser ends on the logo's spring peak.
const riserEnd = scene('cta').start + ct.logo + 8;

export const CUES: Cue[] = [
	cue('hook', EV.hook.words[3], 'pop', 0.8, '"competitor" pill'),

	cue('promise', p.iconClick, 'click', 1, 'toolbar icon click'),
	cue('promise', p.panelOpen, 'whoosh', 0.8, 'side panel slides in'),
	cue('promise', p.typeFrom, 'typing', 0.7, 'domain fills in', p.typeTo - p.typeFrom + 4),
	cue('promise', p.scanClick, 'click', 1, 'Scan click'),
	cue('promise', p.line2 + 8, 'pop', 0.8, '"one click" pill'),

	...[0, 1, 2, 3, 4].map((i) => cue('tags', tg.rowAt(i), 'pop', 0.55, `tag row ${i + 1}`)),
	cue('tags', tg.zoomFrom, 'whoosh', 0.6, 'push in on the panel'),
	cue('tags', tg.glowAt(0), 'tick-counter', 0.7, 'account IDs light up', 36),

	whooshInto('ads'),
	...[0, 1, 2, 3, 4, 5].map((i) => cue('ads', ad.cardAt(i), 'pop', 0.5, `library card ${i + 1}`)),
	cue('ads', ad.cardAt(0) + 12, 'tick-counter', 0.6, 'ad counts tick up (1)'),
	cue('ads', ad.cardAt(0) + 48, 'tick-counter', 0.6, 'ad counts tick up (2)'),
	cue('ads', ad.cardAt(0) + 84, 'tick-counter', 0.6, 'ad counts tick up (3)', 30),
	cue('ads', ad.totalAt, 'ding-success', 0.8, 'totals'),

	whooshInto('labels'),
	...[0, 1, 2, 3].map((i) => cue('labels', lb.rowAt(i), 'pop', 0.5, `ad row ${i + 1}`)),
	cue('labels', lb.highlight, 'pop', 1, '"confirmed" highlight'),
	cue('labels', lb.toggle, 'click', 0.9, '"Only confirmed" switch'),

	whooshInto('export'),
	cue('export', ex.click, 'click', 1, 'Export click'),
	cue('export', ex.fly, 'whoosh', 0.9, 'file flies out'),
	cue('export', ex.land + 8, 'ding-success', 0.8, '"Downloaded"'),

	whooshInto('privacy'),
	...[0, 1, 2].map((i) => cue('privacy', EV.privacy.cardAt(i), 'pop', 0.7, `privacy card ${i + 1}`)),

	{
		sound: 'riser-logo',
		at: riserEnd - LENGTH['riser-logo'],
		frames: LENGTH['riser-logo'],
		volume: BASE['riser-logo'],
		label: 'riser into the logo',
	},
	cue('cta', ct.pill, 'pop', 0.8, 'superpixel.run pill'),
];

/** Per-frame gain inside a cue: 2 frame fade in, 6 frame fade out. */
export const cueGain = (c: Cue, f: number, gain = SFX_GAIN) => {
	const fin = Math.min(1, f / 2);
	const fout = Math.min(1, Math.max(0, (c.frames - f) / 6));
	return Math.min(1, c.volume * gain) * fin * fout;
};
