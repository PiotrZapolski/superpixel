import React from 'react';
import {AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {C, FONT} from './brand';
import {CUES, SFX_GAIN, cueGain} from './sfx';
import {clamp, easeInOut} from './components/ui';
import {Ads} from './scenes/Ads';
import {BrowserStory} from './scenes/BrowserStory';
import {Cta} from './scenes/Cta';
import {Export} from './scenes/Export';
import {Labels} from './scenes/Labels';
import {Privacy} from './scenes/Privacy';
import {LEAD, type SceneId, scene} from './timeline';

/** Hook, promise and tags are one continuous browser shot; the rest are their own segments. */
const SEGMENTS: {id: string; from: SceneId; to: SceneId; Comp: React.FC}[] = [
	{id: 'browser', from: 'hook', to: 'tags', Comp: BrowserStory},
	{id: 'ads', from: 'ads', to: 'ads', Comp: Ads},
	{id: 'labels', from: 'labels', to: 'labels', Comp: Labels},
	{id: 'export', from: 'export', to: 'export', Comp: Export},
	{id: 'privacy', from: 'privacy', to: 'privacy', Comp: Privacy},
	{id: 'cta', from: 'cta', to: 'cta', Comp: Cta},
];

/** Cross-fade with a slight push, centred on the cut (2 * LEAD frames). */
const SegmentFade: React.FC<{first: boolean; last: boolean; duration: number; children: React.ReactNode}> = ({first, last, duration, children}) => {
	const frame = useCurrentFrame();
	const fin = first ? 1 : interpolate(frame, [0, LEAD * 2], [0, 1], {...clamp, easing: easeInOut});
	const fout = last ? 0 : interpolate(frame, [duration - LEAD * 2, duration], [0, 1], {...clamp, easing: easeInOut});
	return (
		<AbsoluteFill style={{opacity: fin * (1 - fout), transform: `translateY(${(1 - fin) * 26 - fout * 26}px) scale(${1.02 - fin * 0.02 - fout * 0.02})`}}>
			{children}
		</AbsoluteFill>
	);
};

const Background: React.FC = () => {
	const frame = useCurrentFrame();
	const x = 28 + Math.sin(frame / 90) * 12;
	const y = 22 + Math.cos(frame / 110) * 10;
	return (
		<AbsoluteFill style={{background: C.paper}}>
			<AbsoluteFill style={{backgroundImage: `radial-gradient(${C.wire} 1.6px, transparent 1.6px)`, backgroundSize: '36px 36px', opacity: 0.9}} />
			<AbsoluteFill
				style={{
					background: `radial-gradient(900px 620px at ${x}% ${y}%, rgba(79,70,229,.13), rgba(79,70,229,0) 70%), radial-gradient(820px 620px at ${100 - x}% ${100 - y}%, rgba(162,28,175,.10), rgba(162,28,175,0) 70%)`,
				}}
			/>
		</AbsoluteFill>
	);
};

// `soundtrack: false` leaves only the sound effects (a stem for checking the mix).
// `sfxGain` overrides SFX_GAIN for trial renders.
export const Explainer: React.FC<{soundtrack?: boolean; sfxGain?: number}> = ({soundtrack = true, sfxGain = SFX_GAIN}) => (
	<AbsoluteFill style={{fontFamily: FONT, color: C.ink, background: C.paper}}>
		<Background />
		{SEGMENTS.map((s, i) => {
			const from = scene(s.from).start;
			const to = scene(s.to).end;
			const first = i === 0;
			const last = i === SEGMENTS.length - 1;
			const duration = to - from + LEAD * 2;
			return (
				<Sequence key={s.id} from={from - LEAD} durationInFrames={duration} name={s.id}>
					<SegmentFade first={first} last={last} duration={duration}>
						<s.Comp />
					</SegmentFade>
				</Sequence>
			);
		})}
		{soundtrack ? <Audio src={staticFile('soundtrack.mp3')} /> : null}
		{CUES.map((c, i) => (
			<Sequence key={i} from={c.at} durationInFrames={c.frames} name={`sfx ${c.label}`} layout="none">
				<Audio src={staticFile(`sfx/${c.sound}.mp3`)} trimBefore={c.trimBefore} volume={(f) => cueGain(c, f, sfxGain)} />
			</Sequence>
		))}
	</AbsoluteFill>
);
