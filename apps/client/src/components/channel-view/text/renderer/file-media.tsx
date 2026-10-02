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
	INITIAL_MEDIA_RETRY_STATE,
	isMediaUnavailable,
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

// An attached image, video or audio file. The URL is built from the store on
// every render, so a refreshed token reaches it; the player is keyed by URL so
// the new link remounts it with a clean error state. When a tokened link fails
// to load, the channel's tokens are refreshed once for that link before the
// file shows as unavailable.
const FileMedia = memo(({ channelId, file, type, onRemove }: TFileMediaProps) => {
	const url = getFileUrl(file);
	const hasAccessToken = Boolean(file._accessToken);
	const [retryState, setRetryState] = useState(INITIAL_MEDIA_RETRY_STATE);
	// Decisions read this ref, not the render's state: one failed load can fire
	// several error events before React re-renders (FullScreenImage renders the
	// image twice), and each must see the refresh the first one started.
	const retryStateRef = useRef(retryState);

	const updateRetryState = useCallback((state: TMediaRetryState) => {
		retryStateRef.current = state;
		setRetryState(state);
	}, []);

	const onLoadError = useCallback(() => {
		const { state, refresh } = resolveMediaLoadError(retryStateRef.current, url, hasAccessToken);

		updateRetryState(state);

		if (!refresh) return;

		void refreshChannelFileAccessTokens(channelId).finally(() => {
			updateRetryState(finishMediaRefresh(retryStateRef.current));
		});
	}, [url, hasAccessToken, channelId, updateRetryState]);

	// Unmounting the failed player while the refresh runs means the retry mounts
	// a fresh one, even when the refresh returned the same link.
	if (retryState.refreshing) return null;

	if (isMediaUnavailable(retryState, url)) {
		return <FileUnavailable name={file.originalName} />;
	}

	if (type === 'image') {
		return <ImageOverride key={url} src={url} onError={onLoadError} />;
	}

	if (type === 'video') {
		return <VideoOverride key={url} src={url} onError={onLoadError} />;
	}

	return (
		<AudioOverride
			key={url}
			src={url}
			name={file.originalName}
			size={file.size}
			href={url}
			onRemove={onRemove}
			onError={onLoadError}
		/>
	);
});

export { FileMedia };
