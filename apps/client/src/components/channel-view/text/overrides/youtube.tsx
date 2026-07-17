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
			<div className="aspect-w-16 aspect-h-9 w-[600px] overflow-hidden rounded-lg border border-border">
				<LiteYouTubeEmbed id={videoId} title="YouTube video" poster="maxresdefault" webp lazyLoad />
			</div>
		</OverrideLayout>
	);
});

export { YoutubeOverride };
