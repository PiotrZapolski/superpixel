import React from 'react';
import {FONT} from '../brand';
import {SITE_NAME} from '../demo-data';

// The fictional competitor's homepage, drawn with plain shapes. It reflows when the side
// panel takes part of the window (flex layout, no fixed widths).

const G = {
	forest: '#1f4d3a',
	forestDeep: '#16382a',
	orange: '#e8743b',
	cream: '#f5efe6',
	sand: '#eadfcd',
	ink: '#1f2a24',
	soft: '#5b6b62',
	sky: '#cfe3e8',
};

const Mountains: React.FC<{style?: React.CSSProperties}> = ({style}) => (
	<svg viewBox="0 0 420 260" preserveAspectRatio="xMidYMax slice" style={{display: 'block', width: '100%', height: '100%', ...style}}>
		<rect width="420" height="260" fill={G.sky} />
		<circle cx="318" cy="70" r="34" fill="#f6c453" />
		<path d="M0 260 L120 96 L190 170 L262 70 L420 260 Z" fill="#7aa58f" />
		<path d="M262 70 L292 108 L276 104 L262 118 L248 102 L236 106 Z" fill="#ffffff" opacity="0.9" />
		<path d="M0 260 L80 170 L150 230 L240 140 L330 220 L420 160 L420 260 Z" fill={G.forest} />
		<path d="M40 260 L58 214 L76 260 Z M96 260 L116 206 L136 260 Z M352 260 L370 210 L388 260 Z" fill={G.forestDeep} />
	</svg>
);

const Product: React.FC<{name: string; price: string; color: string; shape: 'tent' | 'pack' | 'boot'}> = ({name, price, color, shape}) => (
	<div style={{flex: 1, minWidth: 0, background: '#fff', borderRadius: 18, border: '1px solid #e8e1d4', overflow: 'hidden'}}>
		<div style={{height: 120, background: G.cream, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
			<svg viewBox="0 0 100 70" width="120" height="84">
				{shape === 'tent' ? <path d="M10 62 L50 10 L90 62 Z M50 10 L50 62" fill={color} stroke={G.forestDeep} strokeWidth="3" strokeLinejoin="round" /> : null}
				{shape === 'pack' ? (
					<g>
						<rect x="30" y="10" width="40" height="54" rx="12" fill={color} />
						<rect x="38" y="34" width="24" height="18" rx="5" fill={G.forestDeep} opacity="0.35" />
					</g>
				) : null}
				{shape === 'boot' ? <path d="M30 10 h22 v30 l26 10 a8 8 0 0 1 6 8 v6 H30 Z" fill={color} /> : null}
			</svg>
		</div>
		<div style={{padding: '12px 16px'}}>
			<div style={{fontSize: 18, fontWeight: 700, color: G.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{name}</div>
			<div style={{fontSize: 16, color: G.soft}}>{price}</div>
		</div>
	</div>
);

export const AcmePage: React.FC = () => (
	<div style={{position: 'absolute', inset: 0, background: '#fbf8f3', fontFamily: FONT, color: G.ink, overflow: 'hidden'}}>
		<div style={{height: 66, display: 'flex', alignItems: 'center', padding: '0 32px', gap: 28}}>
			<div style={{display: 'flex', alignItems: 'center', gap: 10, flex: 'none'}}>
				<svg viewBox="0 0 24 24" width="30" height="30">
					<path d="M2 20 L10 6 L14 13 L16.5 9 L22 20 Z" fill={G.forest} />
				</svg>
				<span style={{fontSize: 21, fontWeight: 900, letterSpacing: '0.08em', color: G.forest}}>{SITE_NAME.toUpperCase()}</span>
			</div>
			<div style={{flex: 1}} />
			{['Tents', 'Packs', 'Boots', 'Sale'].map((l) => (
				<span key={l} style={{fontSize: 17, fontWeight: 600, color: l === 'Sale' ? G.orange : G.soft}}>
					{l}
				</span>
			))}
			<span style={{width: 38, height: 38, borderRadius: 19, background: G.forest, flex: 'none'}} />
		</div>
		<div style={{margin: '0 28px', height: 330, borderRadius: 26, background: G.cream, display: 'flex', overflow: 'hidden'}}>
			<div style={{flex: '1 1 52%', padding: '40px 44px', display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0}}>
				<div style={{fontSize: 15, fontWeight: 800, letterSpacing: '0.14em', color: G.orange}}>AUTUMN COLLECTION</div>
				<div style={{fontSize: 56, fontWeight: 900, lineHeight: 1.02, letterSpacing: '-0.03em', margin: '12px 0 14px'}}>Gear up for the wild.</div>
				<div style={{fontSize: 19, color: G.soft, lineHeight: 1.4}}>Tents, packs and boots built for every season.</div>
				<div style={{marginTop: 22}}>
					<span style={{display: 'inline-block', background: G.orange, color: '#fff', fontSize: 18, fontWeight: 700, padding: '13px 26px', borderRadius: 999}}>
						Shop the sale
					</span>
				</div>
			</div>
			<div style={{flex: '1 1 48%', minWidth: 0}}>
				<Mountains />
			</div>
		</div>
		<div style={{display: 'flex', gap: 20, margin: '22px 28px 0'}}>
			<Product name="Ridge 2P tent" price="$289" color="#e8743b" shape="tent" />
			<Product name="Trail 38 pack" price="$149" color="#2f6b52" shape="pack" />
			<Product name="Summit boots" price="$179" color="#7a4b2a" shape="boot" />
		</div>
	</div>
);
