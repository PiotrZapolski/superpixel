import {loadFont as loadSchibsted} from '@remotion/google-fonts/SchibstedGrotesk';
import {loadFont as loadMono} from '@remotion/google-fonts/JetBrainsMono';

// Values from sidepanel/sidepanel.css and server/site/assets/style.css. Keep in sync by hand.
export const C = {
	accent1: '#4f46e5',
	accent2: '#a21caf',
	indigo: '#4338ca',
	plum: '#86198f',
	bg: '#e7e4f0',
	paper: '#f3f2f9',
	paperAlt: '#e9e7f3',
	panelBg: '#f6f5fa',
	surface: '#ffffff',
	surface2: '#ece9f5',
	ink: '#1b1523',
	inkSoft: '#4f4868',
	inkMuted: '#6b6478',
	line: '#e4e1ee',
	lineStrong: '#d3cee3',
	wire: '#dedbea',
	highlight: '#facc15',
	highlightBg: '#fef9e0',
	labelBg: '#1a1530',
	ok: '#15803d',
	okBg: '#dcfce7',
	okInk: '#166534',
	advBg: '#e0e7ff',
	advInk: '#3730a3',
	kwBg: '#fef3c7',
	kwInk: '#92400e',
	nameBg: '#ebe8f3',
	nameInk: '#4b4560',
	run: '#4f46e5',
	runBg: '#e9e7fc',
};

export const GRADIENT = `linear-gradient(90deg, ${C.accent1}, ${C.accent2})`;
export const GRADIENT_DIAG = `linear-gradient(135deg, ${C.accent1}, ${C.accent2})`;

const schibsted = loadSchibsted('normal', {
	weights: ['400', '500', '600', '700', '800', '900'],
	subsets: ['latin', 'latin-ext'],
});

const mono = loadMono('normal', {
	weights: ['500', '700'],
	subsets: ['latin'],
});

export const FONT = schibsted.fontFamily;
export const MONO = mono.fontFamily;

export const SHADOW_CARD =
	'0 1px 2px rgba(27,21,35,.05), 0 14px 36px -10px rgba(27,21,35,.16), 0 44px 90px -30px rgba(67,56,202,.22)';
export const SHADOW_SOFT = '0 1px 2px rgba(27,21,35,.05), 0 10px 26px -12px rgba(27,21,35,.18)';
