import React from 'react';
import {Easing, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, FONT, GRADIENT, SHADOW_CARD} from '../brand';
import type {Match} from '../demo-data';
import {LEAD} from '../timeline';

export const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/** Frame inside a segment: 0 is the scene start (segments start LEAD frames early for the cross-fade). */
export const useT = () => useCurrentFrame() - LEAD;

/** Smooth 0..1 progress between two frames. */
export const prog = (frame: number, from: number, to: number, easing = easeOut) =>
	interpolate(frame, [from, Math.max(from + 1, to)], [0, 1], {...clamp, easing});

export const useSpringAt = (frame: number, at: number, config: {damping?: number; stiffness?: number; mass?: number} = {}) => {
	const {fps} = useVideoConfig();
	return spring({frame: frame - at, fps, config: {damping: 15, stiffness: 150, mass: 0.75, ...config}});
};

export const Card: React.FC<{style?: React.CSSProperties; children: React.ReactNode; padding?: number | string}> = ({
	style,
	children,
	padding = 28,
}) => (
	<div
		style={{
			background: C.surface,
			borderRadius: 26,
			border: `1px solid ${C.line}`,
			boxShadow: SHADOW_CARD,
			padding,
			fontFamily: FONT,
			color: C.ink,
			...style,
		}}
	>
		{children}
	</div>
);

/** Soft floating 3D tilt with a gentle drift, for product cards. */
export const Tilt: React.FC<{children: React.ReactNode; rx?: number; ry?: number; drift?: number; style?: React.CSSProperties}> = ({
	children,
	rx = 5,
	ry = -6,
	drift = 1.2,
	style,
}) => {
	const frame = useCurrentFrame();
	const d = Math.sin(frame / 40) * drift;
	return (
		<div style={{perspective: 2400, ...style}}>
			<div style={{transform: `rotateX(${rx + d * 0.4}deg) rotateY(${ry + d}deg)`, transformStyle: 'preserve-3d'}}>{children}</div>
		</div>
	);
};

export type HeadWord = {t: string; at: number; accent?: boolean};

/**
 * Kinetic headline: words rise in on their own frame (on the beat), accent words sit in a
 * brand-gradient pill. `outAt` lifts the whole line away.
 */
export const Headline: React.FC<{
	words: HeadWord[];
	size?: number;
	top?: number;
	outAt?: number;
	frame: number;
}> = ({words, size = 76, top = 72, outAt, frame}) => {
	const {fps} = useVideoConfig();
	const out = outAt === undefined ? 0 : prog(frame, outAt, outAt + 8, easeInOut);
	if (out >= 1) return null;
	return (
		<div
			style={{
				position: 'absolute',
				top,
				left: 60,
				right: 60,
				display: 'flex',
				justifyContent: 'center',
				flexWrap: 'wrap',
				gap: `0 ${size * 0.24}px`,
				fontFamily: FONT,
				fontWeight: 800,
				fontSize: size,
				letterSpacing: '-0.035em',
				color: C.ink,
				lineHeight: 1.18,
				opacity: 1 - out,
				transform: `translateY(${-out * 30}px)`,
				zIndex: 40,
			}}
		>
			{words.map((w, i) => {
				const s = spring({frame: frame - w.at, fps, config: {damping: 15, stiffness: 160, mass: 0.7}});
				const pill = w.accent ? spring({frame: frame - w.at - 3, fps, config: {damping: 18, stiffness: 130}}) : 0;
				return (
					<span
						key={i}
						style={{
							display: 'inline-block',
							opacity: interpolate(s, [0, 0.4], [0, 1], clamp),
							transform: `translateY(${(1 - s) * size * 0.55}px)`,
							position: 'relative',
							padding: w.accent ? `0 ${size * 0.2}px` : 0,
							color: w.accent ? interpolateColor(pill) : C.ink,
						}}
					>
						{w.accent ? (
							<span
								style={{
									position: 'absolute',
									inset: `${size * 0.08}px 0 ${size * 0.02}px 0`,
									background: GRADIENT,
									borderRadius: size * 0.3,
									transform: `scaleX(${pill})`,
									transformOrigin: 'left center',
									zIndex: 0,
									boxShadow: '0 10px 30px -12px rgba(79,70,229,.6)',
								}}
							/>
						) : null}
						<span style={{position: 'relative', zIndex: 1}}>{w.t}</span>
					</span>
				);
			})}
		</div>
	);
};

/** Ink to white as the accent pill grows behind the word. */
const interpolateColor = (p: number) => {
	const v = Math.round(interpolate(p, [0.2, 0.7], [0, 1], clamp) * 255);
	const r = Math.round(27 + (255 - 27) * (v / 255));
	const g = Math.round(21 + (255 - 21) * (v / 255));
	const b = Math.round(35 + (255 - 35) * (v / 255));
	return `rgb(${r},${g},${b})`;
};

/** Mouse cursor that glides between waypoints and pulses on click. */
export const Cursor: React.FC<{path: {x: number; y: number; at: number}[]; clicks?: number[]; frame: number; hideAt?: number}> = ({
	path,
	clicks = [],
	frame,
	hideAt,
}) => {
	let x = path[0].x;
	let y = path[0].y;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1];
		const b = path[i];
		const p = interpolate(frame, [a.at, b.at], [0, 1], {...clamp, easing: easeInOut});
		if (frame >= a.at) {
			x = a.x + (b.x - a.x) * p;
			y = a.y + (b.y - a.y) * p;
		}
	}
	const start = path[0].at;
	const opacity = interpolate(frame, [start - 6, start], [0, 1], clamp) * (hideAt === undefined ? 1 : 1 - prog(frame, hideAt, hideAt + 8));
	const press = Math.max(0, ...clicks.map((c) => interpolate(frame, [c - 3, c, c + 5], [0, 1, 0], clamp)));
	return (
		<div style={{position: 'absolute', left: x, top: y, opacity, pointerEvents: 'none', zIndex: 60}}>
			{clicks.map((c) => {
				if (frame < c) return null;
				const ring = prog(frame, c, c + 18);
				return (
					<div
						key={c}
						style={{
							position: 'absolute',
							left: -40,
							top: -40,
							width: 80,
							height: 80,
							borderRadius: 40,
							border: `4px solid ${C.accent1}`,
							transform: `scale(${0.3 + ring * 1.1})`,
							opacity: 1 - ring,
						}}
					/>
				);
			})}
			<svg
				width={44}
				height={52}
				viewBox="0 0 22 26"
				style={{transform: `scale(${1 - press * 0.14})`, transformOrigin: '2px 2px', filter: 'drop-shadow(0 4px 8px rgba(0,0,0,.25))'}}
			>
				<path d="M2 2 L2 21 L7 16.5 L10.5 24 L13.5 22.6 L10.1 15.3 L17 15 Z" fill={C.ink} stroke="#fff" strokeWidth={1.6} strokeLinejoin="round" />
			</svg>
		</div>
	);
};

const MATCH_COLORS: Record<Match, [string, string]> = {
	confirmed: [C.okBg, C.okInk],
	advertiser: [C.advBg, C.advInk],
	keyword: [C.kwBg, C.kwInk],
	name: [C.nameBg, C.nameInk],
};

/** Match label chip, styled like the landing's .chip.c-* */
export const MatchChip: React.FC<{match: Match; size?: number; style?: React.CSSProperties}> = ({match, size = 22, style}) => (
	<span
		style={{
			display: 'inline-flex',
			alignItems: 'center',
			fontWeight: 700,
			fontSize: size,
			lineHeight: 1.3,
			padding: `${size * 0.12}px ${size * 0.55}px`,
			borderRadius: 999,
			background: MATCH_COLORS[match][0],
			color: MATCH_COLORS[match][1],
			whiteSpace: 'nowrap',
			...style,
		}}
	>
		{match}
	</span>
);

/** Rotating ring, like the side panel's .spinner. */
export const Spinner: React.FC<{size?: number; color?: string; frame: number}> = ({size = 16, color = C.run, frame}) => (
	<span
		style={{
			display: 'inline-block',
			width: size,
			height: size,
			borderRadius: '50%',
			border: `${Math.max(2, size * 0.16)}px solid ${color}33`,
			borderTopColor: color,
			transform: `rotate(${frame * 14}deg)`,
			flex: 'none',
		}}
	/>
);

/** The Superpixel app icon (icons/icon.svg) as inline SVG, crisp at any size. */
export const AppIcon: React.FC<{size: number; style?: React.CSSProperties; glow?: number}> = ({size, style, glow = 1}) => (
	<svg viewBox="4 4 120 120" width={size} height={size} style={{display: 'block', flex: 'none', ...style}}>
		<defs>
			<linearGradient id="sp-bg" x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stopColor="#4F46E5" />
				<stop offset="1" stopColor="#A21CAF" />
			</linearGradient>
			<radialGradient id="sp-glow" cx="0.5" cy="0.5" r="0.5">
				<stop offset="0" stopColor="#FDE68A" stopOpacity={0.9 * glow} />
				<stop offset="1" stopColor="#FDE68A" stopOpacity="0" />
			</radialGradient>
		</defs>
		<rect x="4" y="4" width="120" height="120" rx="28" fill="url(#sp-bg)" />
		<rect x="26" y="26" width="34" height="34" rx="8" fill="#FFFFFF" fillOpacity="0.30" />
		<rect x="26" y="68" width="34" height="34" rx="8" fill="#FFFFFF" fillOpacity="0.30" />
		<rect x="68" y="68" width="34" height="34" rx="8" fill="#FFFFFF" fillOpacity="0.30" />
		<circle cx="85" cy="43" r="30" fill="url(#sp-glow)" />
		<rect x="68" y="26" width="34" height="34" rx="8" fill="#FACC15" />
		<rect x="76" y="34" width="10" height="10" rx="3" fill="#FFFFFF" fillOpacity="0.85" />
	</svg>
);

/** The yellow pixel square from the landing (h1 .dot, tag badges). */
export const Pixel: React.FC<{size?: number}> = ({size = 12}) => (
	<span
		style={{
			display: 'inline-block',
			width: size,
			height: size,
			background: C.highlight,
			borderRadius: size * 0.22,
			boxShadow: `0 0 0 ${Math.max(1, size * 0.12)}px ${C.ink}`,
			flex: 'none',
		}}
	/>
);
