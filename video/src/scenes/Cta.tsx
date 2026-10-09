import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import {C, FONT, GRADIENT} from '../brand';
import {SITE_URL} from '../demo-data';
import {EV} from '../events';
import {Logo} from '../components/logos';
import {AppIcon, Pixel, clamp, prog, useSpringAt, useT} from '../components/ui';

export const Cta: React.FC = () => {
	const t = useT();
	const e = EV.cta;
	const logo = useSpringAt(t, e.logo, {damping: 11, stiffness: 140});
	const name = prog(t, e.name, e.name + 16);
	const tag = useSpringAt(t, e.tagline, {damping: 16, stiffness: 140});
	const pill = useSpringAt(t, e.pill, {damping: 12, stiffness: 170});
	const gh = prog(t, e.github, e.github + 12);
	const glow = prog(t, e.logo, e.logo + 30);
	return (
		<AbsoluteFill style={{fontFamily: FONT, alignItems: 'center', justifyContent: 'center'}}>
			<AbsoluteFill
				style={{
					background: `radial-gradient(620px 420px at 50% 34%, rgba(79,70,229,${0.16 * glow}), rgba(162,28,175,${0.06 * glow}) 55%, rgba(162,28,175,0) 75%)`,
				}}
			/>
			<div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
				<div style={{display: 'flex', alignItems: 'center', gap: 34}}>
					<div style={{transform: `scale(${logo}) rotate(${(1 - logo) * -30}deg)`, filter: 'drop-shadow(0 24px 40px rgba(79,70,229,.35))'}}>
						<AppIcon size={170} />
					</div>
					<div style={{overflow: 'hidden', clipPath: `inset(0 ${(1 - name) * 100}% 0 0)`}}>
						<span style={{display: 'block', fontSize: 132, fontWeight: 900, letterSpacing: '-0.045em', lineHeight: 1, paddingRight: 8}}>Superpixel</span>
					</div>
				</div>
				<div
					style={{
						marginTop: 56,
						fontSize: 56,
						fontWeight: 800,
						letterSpacing: '-0.03em',
						display: 'flex',
						alignItems: 'baseline',
						gap: 6,
						opacity: interpolate(tag, [0, 0.4], [0, 1], clamp),
						transform: `translateY(${(1 - tag) * 30}px)`,
					}}
				>
					See the tags and ads behind any website
					<Pixel size={13} />
				</div>
				<div
					style={{
						marginTop: 48,
						background: GRADIENT,
						color: '#fff',
						fontSize: 48,
						fontWeight: 800,
						letterSpacing: '-0.02em',
						padding: '18px 48px',
						borderRadius: 999,
						transform: `scale(${pill})`,
						boxShadow: '0 22px 44px -18px rgba(79,70,229,.75)',
					}}
				>
					{SITE_URL}
				</div>
				<div
					style={{
						marginTop: 34,
						display: 'flex',
						alignItems: 'center',
						gap: 12,
						fontSize: 30,
						fontWeight: 600,
						color: C.inkSoft,
						opacity: gh,
						transform: `translateY(${(1 - gh) * 14}px)`,
					}}
				>
					<Logo id="github" size={32} color={C.inkSoft} />
					Free on GitHub
				</div>
			</div>
		</AbsoluteFill>
	);
};
