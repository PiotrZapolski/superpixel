import {scene} from './timeline';

// Animation event frames, relative to each scene's start (one beat = 12 frames).
// Scenes animate from these values and src/sfx.ts places the sound effects on them.

const promise = scene('promise');
const tags = scene('tags');

export const EV = {
	hook: {
		words: [6, 12, 18, 24, 36],
	},
	promise: {
		start: promise.start,
		end: promise.end,
		iconClick: 30,
		panelOpen: 33,
		line1: 36,
		typeFrom: 50,
		typeTo: 64,
		line2: 84,
		scanClick: 84,
	},
	tags: {
		start: tags.start,
		end: tags.end,
		line1: 6,
		rowAt: (i: number) => 18 + i * 12,
		libsAt: 84,
		zoomFrom: 96,
		zoomTo: 124,
		line2: 108,
		glowAt: (i: number) => 132 + i * 6,
	},
	ads: {
		line1: 6,
		line2: 48,
		cardAt: (i: number) => 24 + i * 12,
		/** The status chip turns from Running to a result. */
		doneAt: (i: number) => 96 + i * 10,
		totalAt: 168,
	},
	labels: {
		words: 6,
		rowAt: (i: number) => 18 + i * 10,
		highlight: 78,
		toggle: 104,
	},
	export: {
		line: 6,
		click: 40,
		fly: 46,
		land: 72,
	},
	privacy: {
		cardAt: (i: number) => 6 + i * 24,
	},
	cta: {
		logo: 12,
		name: 22,
		tagline: 36,
		pill: 60,
		github: 72,
	},
};
