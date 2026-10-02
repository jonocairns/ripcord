import type { TFile } from '@sharkord/shared';
import { memo, useCallback, useRef, useState } from 'react';
import { refreshChannelFileAccessTokens } from '@/features/server/messages/actions';
import { getFileUrl } from '@/helpers/get-file-url';
import { AudioOverride } from '../overrides/audio';
import { FileUnavailable } from '../overrides/file-unavailable';
import { ImageOverride } from '../overrides/image';
import { VideoOverride } from '../overrides/video';
import {
	finishMediaRefresh,
	getMediaSrc,
	INITIAL_MEDIA_RETRY_STATE,
	isMediaUnavailable,
	markMediaLoaded,
	resolveMediaLoadError,
	type TMediaRetryState,
} from './media-retry';
import type { TFoundMedia } from './types';

type TFileMediaProps = {
	channelId: number;
	file: TFile;
	type: TFoundMedia['type'];
	onRemove?: () => void;
};

// An attached image, video or audio file. Its link is built from the store on
// every render. A player that loaded keeps its link when a refresh changes the
// stored one, so healthy media never reloads; a player that has not loaded yet,
// or that failed, takes the stored link and is keyed by it, so the new link
// remounts it with a clean error state. When a tokened link fails, the
// channel's tokens are refreshed once for that link before the file shows as
// unavailable. "Open in new tab" links always use the stored link.
const FileMedia = memo(({ channelId, file, type, onRemove }: TFileMediaProps) => {
	const storedUrl = getFileUrl(file);
	const hasAccessToken = Boolean(file._accessToken);
	const [retryState, setRetryState] = useState(INITIAL_MEDIA_RETRY_STATE);
	// Decisions read this ref, not the render's state: one load can fire several
	// load or error events before React re-renders (FullScreenImage renders the
	// image twice), and each must see what the first one did.
	const retryStateRef = useRef(retryState);
	const src = getMediaSrc(retryState, storedUrl);

	const updateRetryState = useCallback((state: TMediaRetryState) => {
		retryStateRef.current = state;
		setRetryState(state);
	}, []);

	const onLoaded = useCallback(() => {
		updateRetryState(markMediaLoaded(retryStateRef.current, src));
	}, [src, updateRetryState]);

	const onLoadError = useCallback(() => {
		const { state, refresh } = resolveMediaLoadError(retryStateRef.current, src, storedUrl, hasAccessToken);

		updateRetryState(state);

		if (!refresh) return;

		void refreshChannelFileAccessTokens(channelId).finally(() => {
			updateRetryState(finishMediaRefresh(retryStateRef.current));
		});
	}, [src, storedUrl, hasAccessToken, channelId, updateRetryState]);

	// Unmounting the failed player while the refresh runs means the retry mounts
	// a fresh one, even when the refresh returned the same link.
	if (retryState.refreshing) return null;

	if (isMediaUnavailable(retryState, src)) {
		return <FileUnavailable name={file.originalName} />;
	}

	if (type === 'image') {
		return <ImageOverride key={src} src={src} linkUrl={storedUrl} onLoaded={onLoaded} onError={onLoadError} />;
	}

	if (type === 'video') {
		return <VideoOverride key={src} src={src} onLoaded={onLoaded} onError={onLoadError} />;
	}

	return (
		<AudioOverride
			key={src}
			src={src}
			name={file.originalName}
			size={file.size}
			href={storedUrl}
			onRemove={onRemove}
			onLoaded={onLoaded}
			onError={onLoadError}
		/>
	);
});

export { FileMedia };
