import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {C, FONT, SHADOW_SOFT} from '../brand';
import {DOMAIN, LIBRARIES, TOTAL_ADS, TOTAL_CONFIRMED} from '../demo-data';
import {EV} from '../events';
import {Logo} from '../components/logos';
import {AppIcon, Card, Headline, Spinner, Tilt, clamp, prog, useSpringAt, useT} from '../components/ui';

const CARD_W = 524;
const CARD_H = 236;
const GAP = 34;
const THUMBS = ['#1f4d3a', '#e8743b', '#2f6b52', '#f2c14e', '#7a4b2a', '#9ad1d4'];

export const Ads: React.FC = () => {
	const t = useT();
	const e = EV.ads;
	const total = prog(t, e.totalAt, e.totalAt + 30);
	const totalIn = useSpringAt(t, e.totalAt);
	return (
		<AbsoluteFill style={{fontFamily: FONT}}>
			<Headline
				frame={t}
				words={[
					{t: 'Live ads', at: e.line1, accent: true},
					{t: 'from', at: e.line2},
					{t: '6', at: e.line2 + 6},
					{t: 'public', at: e.line2 + 12},
					{t: 'ad', at: e.line2 + 18},
					{t: 'libraries', at: e.line2 + 24},
				]}
			/>
			<Tilt rx={7} ry={-4} drift={1} style={{position: 'absolute', left: (1920 - (CARD_W * 3 + GAP * 2)) / 2, top: 236}}>
				<div style={{display: 'grid', gridTemplateColumns: `repeat(3, ${CARD_W}px)`, gap: GAP}}>
					{LIBRARIES.map((lib, i) => {
						const s = useSpringAt(t, e.cardAt(i), {damping: 14, stiffness: 150});
						const done = t >= e.doneAt(i);
						const count = Math.round(lib.ads * prog(t, e.cardAt(i) + 10, e.doneAt(i), (x) => x));
						const thumbs = Math.min(4, Math.ceil(count / Math.max(1, lib.ads / 4)));
						const chipIn = useSpringAt(t, e.doneAt(i), {damping: 12, stiffness: 200});
						return (
							<Card
								key={lib.id}
								padding="24px 26px"
								style={{
									width: CARD_W,
									height: CARD_H,
									display: 'flex',
									flexDirection: 'column',
									opacity: interpolate(s, [0, 0.3], [0, 1], clamp),
									transform: `translateY(${(1 - s) * 60}px) scale(${0.9 + s * 0.1})`,
								}}
							>
								<div style={{display: 'flex', alignItems: 'center', gap: 14}}>
									<Logo id={lib.id} size={42} />
									<span style={{fontSize: 28, fontWeight: 700, letterSpacing: '-0.01em', whiteSpace: 'nowrap'}}>{lib.name}</span>
									<div style={{flex: 1}} />
									{done ? (
										<span
											style={{
												fontSize: 20,
												fontWeight: 700,
												padding: '4px 14px',
												borderRadius: 999,
												background: C.okBg,
												color: C.ok,
												whiteSpace: 'nowrap',
												transform: `scale(${0.7 + chipIn * 0.3})`,
											}}
										>
											{lib.confirmed ? `${lib.confirmed} confirmed` : `${lib.ads} ads`}
										</span>
									) : (
										<span
											style={{
												display: 'inline-flex',
												alignItems: 'center',
												gap: 8,
												fontSize: 20,
												fontWeight: 700,
												padding: '4px 14px',
												borderRadius: 999,
												background: C.runBg,
												color: C.run,
											}}
										>
											<Spinner size={16} frame={t} /> Running
										</span>
									)}
								</div>
								<div style={{fontSize: 20, color: C.inkMuted, marginTop: 6, marginLeft: 56}}>{lib.coverage}</div>
								<div style={{flex: 1}} />
								<div style={{display: 'flex', alignItems: 'flex-end', gap: 12}}>
									<span style={{fontSize: 68, fontWeight: 800, lineHeight: 0.9, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums'}}>
										{count}
									</span>
									<span style={{fontSize: 24, color: C.inkMuted, fontWeight: 600, marginBottom: 2}}>ads</span>
									<div style={{flex: 1}} />
									<div style={{display: 'flex', gap: 8}}>
										{[0, 1, 2, 3].map((k) => (
											<div
												key={k}
												style={{
													width: 52,
													height: 52,
													borderRadius: 10,
													background: `linear-gradient(135deg, ${THUMBS[(i + k) % THUMBS.length]}, ${THUMBS[(i + k + 2) % THUMBS.length]})`,
													opacity: k < thumbs ? 1 : 0,
													transform: `scale(${k < thumbs ? 1 : 0.6})`,
													boxShadow: SHADOW_SOFT,
												}}
											/>
										))}
									</div>
								</div>
							</Card>
						);
					})}
				</div>
			</Tilt>
			<div
				style={{
					position: 'absolute',
					left: 0,
					right: 0,
					top: 850,
					display: 'flex',
					justifyContent: 'center',
					opacity: interpolate(totalIn, [0, 0.3], [0, 1], clamp),
					transform: `translateY(${(1 - totalIn) * 30}px)`,
				}}
			>
				<Card padding="18px 30px" style={{display: 'flex', alignItems: 'center', gap: 20, borderRadius: 999}}>
					<AppIcon size={44} />
					<span style={{fontSize: 30, fontWeight: 700}}>{DOMAIN}</span>
					<span style={{width: 2, height: 30, background: C.line}} />
					<span style={{fontSize: 30, fontWeight: 800, fontVariantNumeric: 'tabular-nums'}}>{Math.round(TOTAL_ADS * total)} ads</span>
					<span style={{fontSize: 24, fontWeight: 700, padding: '5px 16px', borderRadius: 999, background: C.okBg, color: C.ok, fontVariantNumeric: 'tabular-nums'}}>
						{Math.round(TOTAL_CONFIRMED * total)} confirmed
					</span>
				</Card>
			</div>
		</AbsoluteFill>
	);
};
