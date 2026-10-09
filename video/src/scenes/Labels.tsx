import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {C, FONT, GRADIENT} from '../brand';
import {AD_ROWS, DOMAIN} from '../demo-data';
import {EV} from '../events';
import {Logo} from '../components/logos';
import {Card, Headline, MatchChip, Tilt, clamp, easeInOut, prog, useSpringAt, useT} from '../components/ui';

export const Labels: React.FC = () => {
	const t = useT();
	const e = EV.labels;
	const hl = useSpringAt(t, e.highlight, {damping: 10, stiffness: 160});
	const toggle = prog(t, e.toggle, e.toggle + 8, easeInOut);
	return (
		<AbsoluteFill style={{fontFamily: FONT}}>
			<Headline
				frame={t}
				size={72}
				words={[
					{t: 'Know', at: e.words},
					{t: 'which', at: e.words + 6},
					{t: 'ads', at: e.words + 12},
					{t: 'really point', at: e.words + 18, accent: true},
					{t: 'to', at: e.words + 30},
					{t: 'the', at: e.words + 36},
					{t: 'site', at: e.words + 42},
				]}
			/>
			<Tilt rx={5} ry={4} drift={0.8} style={{position: 'absolute', left: 270, top: 236, width: 1380}}>
				<Card padding="26px 34px 18px" style={{width: 1380}}>
					<div style={{display: 'flex', alignItems: 'center', marginBottom: 10}}>
						<span style={{fontSize: 32, fontWeight: 800, letterSpacing: '-0.01em'}}>Ads for {DOMAIN}</span>
						<div style={{flex: 1}} />
						<span style={{fontSize: 22, fontWeight: 600, color: C.inkMuted, marginRight: 14}}>Only confirmed</span>
						<div
							style={{
								width: 64,
								height: 36,
								borderRadius: 18,
								background: toggle > 0.5 ? GRADIENT : C.lineStrong,
								position: 'relative',
							}}
						>
							<div
								style={{
									position: 'absolute',
									top: 4,
									left: 4 + toggle * 28,
									width: 28,
									height: 28,
									borderRadius: 14,
									background: '#fff',
									boxShadow: '0 2px 6px rgba(0,0,0,.2)',
								}}
							/>
						</div>
					</div>
					{AD_ROWS.map((row, i) => {
						const s = useSpringAt(t, e.rowAt(i), {damping: 15, stiffness: 160});
						const confirmed = row.match === 'confirmed';
						const dim = confirmed ? 0 : toggle;
						return (
							<div
								key={row.title}
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 22,
									padding: '22px 14px',
									margin: '0 -14px',
									borderTop: `1px solid ${C.line}`,
									borderRadius: 16,
									background: confirmed && hl > 0 ? `rgba(254,249,224,${Math.min(1, hl)})` : 'transparent',
									opacity: interpolate(s, [0, 0.3], [0, 1], clamp) * (1 - dim * 0.65),
									transform: `translateX(${(1 - s) * -50}px)`,
									filter: dim > 0 ? `saturate(${1 - dim * 0.7})` : undefined,
								}}
							>
								<div style={{width: 80, height: 80, borderRadius: 20, background: C.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none'}}>
									<Logo id={row.logo} size={46} />
								</div>
								<div
									style={{
										width: 140,
										height: 100,
										borderRadius: 12,
										background: `linear-gradient(135deg, ${row.thumb[0]}, ${row.thumb[1]})`,
										flex: 'none',
										position: 'relative',
										overflow: 'hidden',
									}}
								>
									<div style={{position: 'absolute', left: 12, right: 30, bottom: 12, height: 10, borderRadius: 5, background: 'rgba(255,255,255,.75)'}} />
									<div style={{position: 'absolute', left: 12, width: 40, bottom: 28, height: 10, borderRadius: 5, background: 'rgba(255,255,255,.5)'}} />
								</div>
								<div style={{flex: 1, minWidth: 0}}>
									<div style={{fontSize: 32, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{row.title}</div>
									<div style={{fontSize: 23, color: C.inkMuted, marginTop: 6}}>{row.meta}</div>
								</div>
								<div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flex: 'none', width: 250}}>
									<div style={{position: 'relative'}}>
										{confirmed && hl > 0 ? (
											<div
												style={{
													position: 'absolute',
													inset: -8,
													borderRadius: 999,
													border: `4px solid ${C.highlight}`,
													boxShadow: '0 0 0 8px rgba(250,204,21,.25)',
													transform: `scale(${0.6 + hl * 0.4})`,
													opacity: Math.min(1, hl),
												}}
											/>
										) : null}
										<MatchChip match={row.match} size={27} style={{transform: confirmed ? `scale(${1 + Math.max(0, hl - 0.6) * 0.15})` : undefined}} />
									</div>
									<span style={{fontSize: 20, color: C.inkMuted, fontWeight: 500}}>{row.hint}</span>
								</div>
							</div>
						);
					})}
				</Card>
			</Tilt>
		</AbsoluteFill>
	);
};
