import t from './timeline.json';

// All times in frames at 30 fps. The soundtrack is trimmed so its first kick lands on
// frame 0; the track runs at 150 BPM, so one beat is 12 frames and every scene
// boundary below sits on a beat.

export type SceneId = 'hook' | 'promise' | 'tags' | 'ads' | 'labels' | 'export' | 'privacy' | 'cta';

export const FPS = t.fps;
export const DURATION_FRAMES = t.duration;
export const BEAT = t.beat;
export const SCENES = t.scenes as {id: SceneId; start: number; end: number}[];

export const scene = (id: SceneId) => {
	const s = SCENES.find((x) => x.id === id);
	if (!s) throw new Error(`unknown scene ${id}`);
	return s;
};

/** Frames of overlap on each side of a cut: segments cross-fade over 2 * LEAD frames. */
export const LEAD = 6;
