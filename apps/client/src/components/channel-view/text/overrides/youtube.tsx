import { memo } from 'react';
import LiteYouTubeEmbed from 'react-lite-youtube-embed';
import 'react-lite-youtube-embed/dist/LiteYouTubeEmbed.css';
import { OverrideLayout } from './layout';

type TYoutubeOverrideProps = {
	videoId: string;
};

const YoutubeOverride = memo(({ videoId }: TYoutubeOverrideProps) => {
	return (
		<OverrideLayout>
			<div className="aspect-w-16 aspect-h-9 w-[600px]">
				<LiteYouTubeEmbed id={videoId} title="What’s new in Material Design for the web (Chrome Dev Summit 2019)" />
			</div>
		</OverrideLayout>
	);
});

export { YoutubeOverride };
