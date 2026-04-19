import { MediaPlayer, type MediaPlayerInstance, MediaProvider } from '@vidstack/react';
import { DefaultVideoLayout, defaultLayoutIcons } from '@vidstack/react/player/layouts/default';
import { memo, useCallback, useRef, useState } from 'react';
import { OverrideLayout } from './layout';
import { useSyncSharedMediaPreferences } from './shared-media-preferences';

import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/video.css';

type TVideoOverrideProps = {
	src: string;
};

const VideoOverride = memo(({ src }: TVideoOverrideProps) => {
	const [error, setError] = useState(false);
	const playerRef = useRef<MediaPlayerInstance>(null);

	const onError = useCallback(() => {
		setError(true);
	}, []);

	const mediaPreferences = useSyncSharedMediaPreferences(playerRef);

	if (error) return null;

	return (
		<OverrideLayout>
			<div className="w-full max-w-[520px] overflow-hidden rounded-lg border border-border leading-none shadow-sm">
				<MediaPlayer
					ref={playerRef}
					src={src}
					load="visible"
					viewType="video"
					storage="ripcord-media"
					onError={onError}
					aspectRatio="16/9"
					volume={mediaPreferences.volume}
					muted={mediaPreferences.muted}
				>
					<MediaProvider />
					<DefaultVideoLayout icons={defaultLayoutIcons} />
				</MediaPlayer>
			</div>
		</OverrideLayout>
	);
});

export { VideoOverride };
