import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {C, FONT, GRADIENT, GRADIENT_DIAG, MONO, SHADOW_CARD} from '../brand';
import {DOMAIN, EXPORT_FILE, LIBRARIES, TAGS, TOTAL_ADS} from '../demo-data';
import {EV} from '../events';
import {AppIcon, Card, Cursor, Headline, Tilt, clamp, easeInOut, prog, useSpringAt, useT} from '../components/ui';

// The real export: Settings > Data > "Export last scan as JSON" (sidepanel.html).

const BTN = {x: 370, y: 696};

const JsonLine: React.FC<{k: string; v: string; note?: string; color?: string; last?: boolean}> = ({k, v, note, color = '#a21caf', last}) => (
	<div style={{display: 'flex', alignItems: 'center', gap: 14, whiteSpace: 'nowrap', paddingLeft: 40}}>
		<span>
			<span style={{color: C.indigo}}>"{k}"</span>: <span style={{color}}>{v}</span>
			{last ? '' : ','}
		</span>
		{note ? (
			<span style={{fontFamily: FONT, fontSize: 18, fontWeight: 700, color: C.inkMuted, background: C.surface2, borderRadius: 999, padding: '2px 12px'}}>{note}</span>
		) : null}
	</div>
);

export const Export: React.FC = () => {
	const t = useT();
	const e = EV.export;
	const press = interpolate(t, [e.click - 3, e.click, e.click + 6], [0, 1, 0], clamp);
	const fly = prog(t, e.fly, e.land, easeInOut);
	const landed = useSpringAt(t, e.land, {damping: 11, stiffness: 170});
	const done = useSpringAt(t, e.land + 8, {damping: 12, stiffness: 190});
	// File card flies from the button to its resting place on the right.
	const x = interpolate(fly, [0, 1], [BTN.x + 40, 990]);
	const y = interpolate(fly, [0, 1], [BTN.y - 60, 350]) - Math.sin(fly * Math.PI) * 120;
	const sc = interpolate(fly, [0, 1], [0.25, 1]) * (t >= e.land ? 0.97 + landed * 0.03 : 1);
	const rot = interpolate(fly, [0, 1], [-14, 3]);
	return (
		<AbsoluteFill style={{fontFamily: FONT}}>
			<Headline
				frame={t}
				words={[
					{t: 'Export', at: e.line, accent: true},
					{t: 'the', at: e.line + 6},
					{t: 'full', at: e.line + 12},
					{t: 'scan', at: e.line + 18},
				]}
			/>
			<Tilt rx={4} ry={8} drift={0.8} style={{position: 'absolute', left: 120, top: 390}}>
				<Card padding="0" style={{width: 720, overflow: 'hidden'}}>
					<div style={{background: C.bg, padding: '20px 26px', display: 'flex', alignItems: 'center', gap: 12}}>
						<AppIcon size={34} />
						<span style={{fontSize: 26, fontWeight: 700}}>Settings</span>
					</div>
					<div style={{height: 3, background: GRADIENT}} />
					<div style={{padding: '22px 26px 30px'}}>
						<div style={{fontSize: 16, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkMuted}}>Platforms</div>
						<div style={{display: 'flex', flexWrap: 'wrap', gap: '8px 22px', margin: '12px 0 26px', fontSize: 24}}>
							{LIBRARIES.map((l) => (
								<span key={l.id} style={{display: 'inline-flex', alignItems: 'center', gap: 8}}>
									<span style={{width: 20, height: 20, borderRadius: 5, background: GRADIENT_DIAG, color: '#fff', fontSize: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}>
										&#10003;
									</span>
									{l.name}
								</span>
							))}
						</div>
						<div style={{fontSize: 16, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.inkMuted}}>Data</div>
						<div
							style={{
								marginTop: 12,
								display: 'inline-flex',
								alignItems: 'center',
								gap: 12,
								fontSize: 27,
								fontWeight: 600,
								padding: '16px 28px',
								borderRadius: 12,
								border: `1.5px solid ${press > 0 ? C.accent1 : C.lineStrong}`,
								background: press > 0 ? C.runBg : C.surface,
								transform: `scale(${1 - press * 0.05})`,
							}}
						>
							<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke={C.ink} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 4v11" />
								<path d="m7 10 5 5 5-5" />
								<path d="M5 20h14" />
							</svg>
							Export last scan as JSON
						</div>
					</div>
				</Card>
			</Tilt>

			{t >= e.fly ? (
				<div
					style={{
						position: 'absolute',
						left: x,
						top: y,
						transform: `scale(${sc}) rotate(${rot}deg)`,
						transformOrigin: '0 0',
						zIndex: 30,
					}}
				>
					<div style={{width: 820, background: C.surface, borderRadius: 26, boxShadow: SHADOW_CARD, border: `1px solid ${C.line}`, overflow: 'hidden'}}>
						<div style={{display: 'flex', alignItems: 'center', gap: 16, padding: '22px 26px', borderBottom: `1px solid ${C.line}`}}>
							<div
								style={{
									width: 58,
									height: 58,
									borderRadius: 14,
									background: GRADIENT_DIAG,
									color: '#fff',
									fontFamily: MONO,
									fontWeight: 700,
									fontSize: 22,
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
								}}
							>
								{'{ }'}
							</div>
							<div style={{fontFamily: MONO, fontSize: 23, fontWeight: 700, whiteSpace: 'nowrap'}}>{EXPORT_FILE}</div>
						</div>
						<div style={{fontFamily: MONO, fontSize: 26, lineHeight: 1.7, padding: '18px 26px 22px', color: C.ink, whiteSpace: 'pre'}}>
							<div>{'{'}</div>
							<JsonLine k="domain" v={`"${DOMAIN}"`} />
							<JsonLine k="at" v={'"2026-10-09T10:24:00Z"'} />
							<JsonLine k="tags" v="[...]" color={C.ink} note={`${TAGS.length} tags`} />
							<JsonLine k="results" v="[...]" color={C.ink} note={`${LIBRARIES.length} libraries, ${TOTAL_ADS} ads`} last />
							<div>{'}'}</div>
						</div>
					</div>
					<div
						style={{
							position: 'absolute',
							right: 28,
							bottom: -26,
							display: 'inline-flex',
							alignItems: 'center',
							gap: 10,
							fontSize: 24,
							fontWeight: 700,
							padding: '10px 20px',
							borderRadius: 999,
							background: C.okBg,
							color: C.ok,
							boxShadow: '0 10px 24px -12px rgba(21,128,61,.6)',
							transform: `scale(${done})`,
						}}
					>
						<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke={C.ok} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
							<path d="M5 12.5l4.5 4.5L19 7.5" />
						</svg>
						Downloaded
					</div>
				</div>
			) : null}

			<Cursor
				frame={t}
				path={[
					{x: 760, y: 900, at: 4},
					{x: BTN.x, y: BTN.y, at: e.click - 4},
					{x: BTN.x + 30, y: BTN.y + 60, at: e.click + 30},
				]}
				clicks={[e.click]}
				hideAt={e.click + 24}
			/>
		</AbsoluteFill>
	);
};
