import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {C, FONT, GRADIENT_DIAG} from '../brand';
import {EV} from '../events';
import {Logo} from '../components/logos';
import {Card, clamp, useSpringAt, useT} from '../components/ui';

const ITEMS: {title: string; sub: string; icon: React.ReactNode}[] = [
	{
		title: 'Free.',
		sub: 'No sign-up, no paywall.',
		icon: <span style={{fontSize: 46, fontWeight: 900, color: '#fff', letterSpacing: '-0.03em'}}>$0</span>,
	},
	{
		title: 'Open source.',
		sub: 'MIT license, code on GitHub.',
		icon: <Logo id="github" size={58} color="#fff" />,
	},
	{
		title: 'Runs in your browser.',
		sub: 'Results stay on your machine.',
		icon: (
			<svg viewBox="0 0 24 24" width="58" height="58" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
				<rect x="2.5" y="4" width="19" height="15" rx="2.5" />
				<path d="M2.5 8.5h19" />
				<rect x="9" y="12" width="6" height="4.5" rx="1" />
				<path d="M10.2 12v-1.2a1.8 1.8 0 0 1 3.6 0V12" />
			</svg>
		),
	},
];

export const Privacy: React.FC = () => {
	const t = useT();
	return (
		<AbsoluteFill style={{fontFamily: FONT, alignItems: 'center', justifyContent: 'center'}}>
			<div style={{display: 'flex', gap: 40, perspective: 2400}}>
				{ITEMS.map((it, i) => {
					const s = useSpringAt(t, EV.privacy.cardAt(i), {damping: 13, stiffness: 150});
					const float = Math.sin((t + i * 20) / 30) * 6;
					return (
						<Card
							key={it.title}
							padding="40px 40px 36px"
							style={{
								width: 500,
								height: 440,
								display: 'flex',
								flexDirection: 'column',
								opacity: interpolate(s, [0, 0.3], [0, 1], clamp),
								transform: `translateY(${(1 - s) * 90 + float}px) rotateY(${(1 - s) * (i - 1) * -18}deg) rotate(${(i - 1) * 1.2}deg)`,
							}}
						>
							<div
								style={{
									width: 112,
									height: 112,
									borderRadius: 30,
									background: GRADIENT_DIAG,
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									boxShadow: '0 16px 34px -14px rgba(79,70,229,.7)',
								}}
							>
								{it.icon}
							</div>
							<div style={{flex: 1}} />
							<div style={{fontSize: 64, fontWeight: 800, lineHeight: 1.02, letterSpacing: '-0.035em'}}>{it.title}</div>
							<div style={{fontSize: 25, color: C.inkMuted, marginTop: 14}}>{it.sub}</div>
						</Card>
					);
				})}
			</div>
		</AbsoluteFill>
	);
};
