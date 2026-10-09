import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {C, FONT, SHADOW_CARD} from '../brand';
import {DOMAIN, PAGE_BADGES, TAGS} from '../demo-data';
import {AcmePage} from '../components/AcmePage';
import {Logo} from '../components/logos';
import {PANEL_W, SidePanel} from '../components/SidePanel';
import {AppIcon, Cursor, Headline, Pixel, clamp, easeInOut, prog, useSpringAt, useT} from '../components/ui';
import {EV} from '../events';

// Scenes hook, promise and tags in one continuous shot: the competitor's site in a
// browser, the Superpixel panel opening, tags filling the panel and badges on the page.

export const WIN = {x: 200, y: 250, w: 1520, h: 780};
const CHROME_H = 96;
const CONTENT_H = WIN.h - CHROME_H;

const Badge: React.FC<{label: string; logo: (typeof PAGE_BADGES)[number]['logo']; s: number}> = ({label, logo, s}) => (
	<div
		style={{
			display: 'inline-flex',
			alignItems: 'center',
			gap: 9,
			background: C.labelBg,
			color: '#fff',
			fontFamily: FONT,
			fontSize: 18,
			fontWeight: 700,
			padding: '7px 14px 7px 10px',
			borderRadius: 999,
			whiteSpace: 'nowrap',
			boxShadow: '0 10px 24px -10px rgba(26,21,48,.6)',
			transform: `scale(${s})`,
			transformOrigin: 'left center',
			opacity: interpolate(s, [0, 0.3], [0, 1], clamp),
		}}
	>
		<Pixel size={11} />
		<span style={{background: '#fff', borderRadius: 7, padding: 3, display: 'flex'}}>
			<Logo id={logo} size={18} />
		</span>
		{label}
	</div>
);

const ChromeBar: React.FC<{iconPress: number}> = ({iconPress}) => (
	<div style={{height: CHROME_H, background: '#dfdce8', fontFamily: FONT}}>
		<div style={{height: 44, display: 'flex', alignItems: 'flex-end', padding: '0 16px', gap: 14}}>
			<div style={{display: 'flex', gap: 8, alignSelf: 'center', marginRight: 10}}>
				{['#ff5f57', '#febc2e', '#28c840'].map((c) => (
					<span key={c} style={{width: 13, height: 13, borderRadius: 7, background: c}} />
				))}
			</div>
			<div
				style={{
					height: 36,
					width: 360,
					whiteSpace: 'nowrap',
					background: '#f7f6fb',
					borderRadius: '12px 12px 0 0',
					display: 'flex',
					alignItems: 'center',
					gap: 10,
					padding: '0 14px',
					fontSize: 16,
					color: C.ink,
				}}
			>
				<svg viewBox="0 0 24 24" width="18" height="18">
					<path d="M2 20 L10 6 L14 13 L16.5 9 L22 20 Z" fill="#1f4d3a" />
				</svg>
				Acme Outdoor | Gear for the wild
			</div>
		</div>
		<div style={{height: 52, background: '#f7f6fb', display: 'flex', alignItems: 'center', padding: '0 18px', gap: 16}}>
			{['M15 6l-6 6 6 6', 'M9 6l6 6-6 6'].map((d) => (
				<svg key={d} viewBox="0 0 24 24" width="22" height="22" fill="none" stroke={C.inkMuted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
					<path d={d} />
				</svg>
			))}
			<div
				style={{
					flex: 1,
					height: 36,
					borderRadius: 18,
					background: '#ebe8f2',
					display: 'flex',
					alignItems: 'center',
					gap: 10,
					padding: '0 16px',
					fontSize: 18,
					color: C.ink,
				}}
			>
				<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={C.inkMuted} strokeWidth="2.4">
					<rect x="5" y="11" width="14" height="10" rx="2" />
					<path d="M8 11V8a4 4 0 0 1 8 0v3" />
				</svg>
				{DOMAIN}
			</div>
			<svg viewBox="0 0 24 24" width="22" height="22" fill={C.inkMuted}>
				<path d="M10 3a2 2 0 0 1 4 0v2h4a1 1 0 0 1 1 1v4h-2a2 2 0 0 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 0 0-4 0v2H6a1 1 0 0 1-1-1v-4h2a2 2 0 0 0 0-4H5V6a1 1 0 0 1 1-1h4z" />
			</svg>
			<div
				style={{
					width: 40,
					height: 40,
					borderRadius: 10,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					background: iconPress > 0 ? `rgba(79,70,229,${0.18 * iconPress})` : 'transparent',
				}}
			>
				<AppIcon size={30} style={{transform: `scale(${1 - iconPress * 0.12})`}} />
			</div>
			<span style={{width: 30, height: 30, borderRadius: 15, background: '#c9c4dc'}} />
		</div>
	</div>
);

export const BrowserStory: React.FC = () => {
	const g = useT();
	const p = EV.promise;
	const tg = EV.tags;
	const pl = g - p.start;
	const tl = g - tg.start;

	// Camera: settle in during the hook, then push in on the panel for the account IDs.
	const settle = prog(g, 0, 100, easeInOut);
	const zoom = prog(tl, tg.zoomFrom, tg.zoomTo, easeInOut);
	const s0 = interpolate(settle, [0, 1], [1.08, 1]);
	const s = s0 * interpolate(zoom, [0, 1], [1, 1.2]);
	// The settle scales around the window's centre; the zoom is done by then.
	const tx = interpolate(zoom, [0, 1], [0, -572]) + (1 - s0) * 960;
	const ty = interpolate(zoom, [0, 1], [0, -85]) + (1 - s0) * 640;
	const drift = Math.sin(g / 45);

	// Panel and page state.
	const open = useSpringAt(pl, p.panelOpen, {damping: 20, stiffness: 120, mass: 0.9});
	const panelW = PANEL_W * open;
	const iconPress = interpolate(pl, [p.iconClick - 3, p.iconClick, p.iconClick + 8], [0, 1, 0], clamp);
	const typed = prog(pl, p.typeFrom, p.typeTo, (x) => x);
	const scanPress = interpolate(pl, [p.scanClick - 3, p.scanClick, p.scanClick + 6], [0, 1, 0], clamp);
	const scanning = pl >= p.scanClick + 2;
	const rows = TAGS.map((_, i) => useSpringAt(tl, tg.rowAt(i), {damping: 14, stiffness: 170}));
	const badges = PAGE_BADGES.map((_, i) => useSpringAt(tl, tg.rowAt(i) + 2, {damping: 12, stiffness: 180}));
	const idGlow = TAGS.map((_, i) => prog(tl, tg.glowAt(i), tg.glowAt(i) + 8));
	const libs = prog(tl, tg.libsAt, tg.libsAt + 12);

	// Canvas positions (camera at rest) for the cursor.
	const iconX = WIN.x + WIN.w - 18 - 30 - 16 - 20;
	const iconY = WIN.y + 44 + 26;
	const scanX = WIN.x + WIN.w - 20 - 50;
	const scanY = WIN.y + CHROME_H + 16 + 30 + 12 + 25;

	return (
		<AbsoluteFill>
			<AbsoluteFill style={{transformOrigin: '0 0', transform: `translate(${tx}px, ${ty}px) scale(${s})`}}>
				<div style={{position: 'absolute', left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, perspective: 2600}}>
					<div
						style={{
							width: '100%',
							height: '100%',
							borderRadius: 18,
							overflow: 'hidden',
							background: '#fff',
							boxShadow: SHADOW_CARD,
							border: `1px solid ${C.lineStrong}`,
							transform: `rotateX(${(1 - zoom) * 2 + drift * 0.4}deg) rotateY(${(1 - zoom) * -1.5 + drift * 0.6}deg)`,
						}}
					>
						<ChromeBar iconPress={iconPress} />
						<div style={{position: 'relative', height: CONTENT_H, display: 'flex'}}>
							<div style={{position: 'relative', flex: 1, minWidth: 0}}>
								<AcmePage />
								{PAGE_BADGES.map((b, i) => (
									<div key={b.label} style={{position: 'absolute', left: `${b.x * 100}%`, top: `${b.y * 100}%`}}>
										<Badge label={b.label} logo={b.logo} s={badges[i]} />
									</div>
								))}
							</div>
							<div
								style={{
									position: 'relative',
									width: panelW,
									flex: 'none',
									borderLeft: panelW > 1 ? `1px solid ${C.lineStrong}` : 'none',
									boxShadow: '-18px 0 40px -24px rgba(27,21,35,.35)',
									overflow: 'hidden',
								}}
							>
								<div style={{position: 'absolute', top: 0, bottom: 0, left: 0, width: PANEL_W}}>
									<SidePanel s={{frame: g, typed, scanPress, scanning, rows, idGlow, libs}} />
								</div>
							</div>
						</div>
					</div>
				</div>
			</AbsoluteFill>

			<Cursor
				frame={pl}
				path={[
					{x: 1080, y: 760, at: 0},
					{x: iconX, y: iconY, at: p.iconClick - 4},
					{x: iconX, y: iconY, at: p.iconClick + 18},
					{x: scanX, y: scanY, at: p.scanClick - 4},
				]}
				clicks={[p.iconClick, p.scanClick]}
				hideAt={p.scanClick + 16}
			/>

			<Headline
				frame={g}
				outAt={p.start - 8}
				words={[
					{t: 'What', at: 6},
					{t: 'is', at: 12},
					{t: 'your', at: 18},
					{t: 'competitor', at: 24, accent: true},
					{t: 'running?', at: 36},
				]}
			/>
			<Headline
				frame={pl}
				outAt={p.line2 - 8}
				words={[
					{t: 'Superpixel', at: p.line1, accent: true},
					{t: 'shows', at: p.line1 + 6},
					{t: 'you.', at: p.line1 + 12},
				]}
			/>
			<Headline
				frame={pl}
				outAt={p.end - p.start - 6}
				words={[
					{t: 'In', at: p.line2},
					{t: 'one click.', at: p.line2 + 6, accent: true},
				]}
			/>
			<Headline
				frame={tl}
				outAt={tg.line2 - 8}
				words={[
					{t: 'Every', at: tg.line1},
					{t: 'tag.', at: tg.line1 + 6, accent: true},
				]}
			/>
			<Headline
				frame={tl}
				words={[
					{t: 'With', at: tg.line2},
					{t: 'its', at: tg.line2 + 6},
					{t: 'account ID.', at: tg.line2 + 12, accent: true},
				]}
			/>
		</AbsoluteFill>
	);
};
