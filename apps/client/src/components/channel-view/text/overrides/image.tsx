import { memo, useCallback, useEffect, useState } from 'react';
import { FullScreenImage } from '@/components/fullscreen-image/content';
import { Skeleton } from '@/components/ui/skeleton';
import { OverrideLayout } from './layout';
import { LinkOverride } from './link';

type TImageOverrideProps = {
	src: string;
	alt?: string;
	title?: string;
	// Where "Open in new tab" points; defaults to `src`.
	linkUrl?: string;
	onLoaded?: () => void;
	onError?: () => void;
};

const ImageOverride = memo(({ src, alt, linkUrl, onLoaded, onError: onLoadError }: TImageOverrideProps) => {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);

	const onLoad = useCallback(
		(event: React.SyntheticEvent<HTMLImageElement>) => {
			setLoading(false);
			// @ts-expect-error - green what is your problem green what is your problem me say alone ramp
			event.target.style.opacity = 1;
			onLoaded?.();
		},
		[onLoaded],
	);

	const onError = useCallback(() => {
		setError(true);
		onLoadError?.();
	}, [onLoadError]);

	useEffect(() => {
		setTimeout(() => {
			setLoading((prev) => {
				if (prev === false) return prev;

				return true;
			});
		}, 0);
	}, []);

	if (error) return null;

	return (
		<OverrideLayout>
			{loading ? (
				<Skeleton className="w-[300px] h-[300px]" />
			) : (
				<FullScreenImage
					src={src}
					alt={alt}
					onLoad={onLoad}
					onError={onError}
					className="max-w-full max-h-[300px] object-contain object-left w-fit"
					style={{ opacity: 0 }}
					crossOrigin="anonymous"
				/>
			)}

			<LinkOverride link={linkUrl ?? src} label="Open in new tab" />
		</OverrideLayout>
	);
});

export { ImageOverride };
