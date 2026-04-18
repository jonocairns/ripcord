import { MediaPlayer, MediaProvider } from '@vidstack/react';
import { DefaultAudioLayout, defaultLayoutIcons } from '@vidstack/react/player/layouts/default';
import { memo, useCallback, useState } from 'react';
import { OverrideLayout } from './layout';

import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/audio.css';
import './vidstack.css';

type TAudioOverrideProps = {
	src: string;
};

const AudioOverride = memo(({ src }: TAudioOverrideProps) => {
	const [error, setError] = useState(false);

	const onError = useCallback(() => {
		setError(true);
	}, []);

	if (error) return null;

	return (
		<OverrideLayout>
			<div className="w-[520px] max-w-full">
				<MediaPlayer src={src} load="visible" viewType="audio" storage="ripcord-media" onError={onError}>
					<MediaProvider />
					<DefaultAudioLayout icons={defaultLayoutIcons} smallLayoutWhen={false} />
				</MediaPlayer>
			</div>
		</OverrideLayout>
	);
});

export { AudioOverride };
