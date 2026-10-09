import React from 'react';
import {Composition} from 'remotion';
import {Explainer} from './Explainer';
import {DURATION_FRAMES, FPS} from './timeline';

export const RemotionRoot: React.FC = () => (
	<Composition
		id="Explainer"
		component={Explainer}
		durationInFrames={DURATION_FRAMES}
		fps={FPS}
		width={1920}
		height={1080}
		defaultProps={{soundtrack: true}}
	/>
);
