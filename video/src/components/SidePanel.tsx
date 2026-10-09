import React from 'react';
import {interpolate} from 'remotion';
import {C, FONT, GRADIENT, MONO} from '../brand';
import {DOMAIN, TAGS} from '../demo-data';
import {Logo} from './logos';
import {AppIcon, Spinner, clamp} from './ui';

// The Superpixel side panel (sidepanel/sidepanel.html + .css), simplified and scaled
// about 1.5x so it reads in a 1080p frame.

export const PANEL_W = 540;

export type PanelState = {
	frame: number;
	/** 0..1, how much of the domain is in the input. */
	typed: number;
	/** 0..1 press animation of the Scan button. */
	scanPress: number;
	scanning: boolean;
	/** Spring value 0..1 per tag row (TAGS order). */
	rows: number[];
	/** 0..1 highlight per tag ID chip. */
	idGlow: number[];
	/** 0..1, the "Ad libraries" header with its running spinner. */
	libs: number;
};

const CATEGORY_ORDER = ['Tag managers', 'Analytics', 'Ads'];

export const SidePanel: React.FC<{s: PanelState}> = ({s}) => {
	const shown = Math.round(DOMAIN.length * s.typed);
	const visibleTags = s.rows.filter((r) => r > 0.05).length;
	return (
		<div style={{position: 'absolute', inset: 0, background: C.panelBg, fontFamily: FONT, color: C.ink, overflow: 'hidden'}}>
			<div style={{background: C.bg, padding: '16px 20px 0'}}>
				<div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12}}>
					<AppIcon size={30} style={{borderRadius: 7}} />
					<span style={{fontSize: 23, fontWeight: 700}}>Superpixel</span>
					<div style={{flex: 1}} />
					<div style={{display: 'flex', gap: 4}}>
						{[0, 1, 2].map((i) => (
							<span key={i} style={{width: 6, height: 6, borderRadius: 3, background: C.inkMuted}} />
						))}
					</div>
				</div>
				<div style={{display: 'flex', gap: 10, alignItems: 'center'}}>
					<div
						style={{
							flex: 1,
							height: 50,
							background: C.surface,
							border: `1.5px solid ${s.typed > 0 && s.typed < 1 ? C.accent1 : C.lineStrong}`,
							borderRadius: 11,
							display: 'flex',
							alignItems: 'center',
							padding: '0 10px 0 14px',
							gap: 8,
							minWidth: 0,
						}}
					>
						<span style={{flex: 1, fontSize: 20, color: shown ? C.ink : C.inkMuted, whiteSpace: 'nowrap', overflow: 'hidden'}}>
							{shown ? DOMAIN.slice(0, shown) : 'example.com'}
							{s.typed > 0 && s.typed < 1 ? <span style={{color: C.accent1}}>|</span> : null}
						</span>
						<span style={{fontSize: 15, fontWeight: 600, color: C.inkMuted, background: C.surface2, borderRadius: 8, padding: '4px 9px'}}>This tab</span>
					</div>
					<div
						style={{
							height: 50,
							padding: '0 24px',
							borderRadius: 11,
							background: GRADIENT,
							color: '#fff',
							fontSize: 20,
							fontWeight: 600,
							display: 'flex',
							alignItems: 'center',
							transform: `scale(${1 - s.scanPress * 0.08})`,
							filter: `brightness(${1 + s.scanPress * 0.15})`,
							boxShadow: '0 8px 20px -10px rgba(79,70,229,.8)',
						}}
					>
						Scan
					</div>
				</div>
				<div style={{height: 3, margin: '14px -20px 0', background: GRADIENT}} />
			</div>

			<div style={{padding: '14px 18px'}}>
				<div
					style={{
						height: 30,
						display: 'flex',
						alignItems: 'center',
						gap: 10,
						fontSize: 17,
						color: C.inkMuted,
						opacity: s.scanning ? 1 : 0,
					}}
				>
					<Spinner size={17} frame={s.frame} />
					<span>
						Scanning <b style={{color: C.ink}}>{DOMAIN}</b>...
					</span>
				</div>

				<div
					style={{
						marginTop: 10,
						background: C.surface,
						border: `1px solid ${C.line}`,
						borderRadius: 16,
						padding: '12px 16px 6px',
						opacity: interpolate(s.rows[0] ?? 0, [0, 0.3], [0, 1], clamp),
					}}
				>
					<div style={{fontSize: 19, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4}}>
						<span style={{color: C.inkMuted, transform: 'rotate(90deg)', display: 'inline-block'}}>&#8250;</span>
						Tracking on the site ({visibleTags})
					</div>
					{CATEGORY_ORDER.map((cat) => {
						const items = TAGS.map((t, i) => ({t, i})).filter((x) => x.t.category === cat);
						const groupIn = Math.max(...items.map((x) => s.rows[x.i] ?? 0));
						if (groupIn <= 0.01) return null;
						return (
							<div key={cat} style={{marginTop: 6}}>
								<div
									style={{
										fontSize: 13,
										fontWeight: 700,
										letterSpacing: '0.08em',
										textTransform: 'uppercase',
										color: C.inkMuted,
										opacity: interpolate(groupIn, [0, 0.5], [0, 1], clamp),
										margin: '4px 0 2px',
									}}
								>
									{cat}
								</div>
								{items.map(({t, i}) => {
									const r = s.rows[i] ?? 0;
									if (r <= 0.01) return null;
									const glow = s.idGlow[i] ?? 0;
									return (
										<div
											key={t.name}
											style={{
												display: 'flex',
												alignItems: 'center',
												gap: 10,
												padding: '9px 0',
												borderTop: `1px solid ${C.line}`,
												opacity: interpolate(r, [0, 0.35], [0, 1], clamp),
												transform: `translateX(${(1 - r) * 40}px) scale(${0.92 + r * 0.08})`,
												transformOrigin: 'left center',
												maxHeight: r * 60,
											}}
										>
											<div style={{display: 'flex', alignItems: 'center', gap: 10, fontSize: 19, fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: 'nowrap'}}>
												<Logo id={t.logo} size={22} />
												{t.name}
											</div>
											<div style={{display: 'flex', flex: 'none'}}>
												<code
													style={{
														fontFamily: MONO,
														fontSize: 16,
														fontWeight: 500,
														background: glow > 0 ? C.highlightBg : C.surface2,
														border: `1.5px solid ${glow > 0 ? C.highlight : 'transparent'}`,
														boxShadow: glow > 0 ? `0 0 0 ${glow * 4}px rgba(250,204,21,.35)` : 'none',
														borderRadius: 7,
														padding: '3px 9px',
														color: C.ink,
													}}
												>
													{t.id}
												</code>
											</div>
										</div>
									);
								})}
							</div>
						);
					})}
				</div>

				<div
					style={{
						marginTop: 14,
						display: 'flex',
						alignItems: 'center',
						gap: 10,
						fontSize: 19,
						fontWeight: 700,
						opacity: s.libs,
						transform: `translateY(${(1 - s.libs) * 16}px)`,
					}}
				>
					Ad libraries
					<span style={{display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, color: C.run, background: C.runBg, borderRadius: 999, padding: '3px 10px'}}>
						<Spinner size={13} frame={s.frame} /> 6 running
					</span>
				</div>
			</div>
		</div>
	);
};
