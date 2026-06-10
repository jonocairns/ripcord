import { type DesktopCapturerSource, desktopCapturer, type NativeImage } from 'electron';
import type { TPreparedScreenShare, TScreenShareSelection, TShareSource, TShareSourceThumbnail } from './types';

let preparedScreenShare: TPreparedScreenShare | undefined;

const prepareScreenShareSelection = (selection: TScreenShareSelection) => {
	preparedScreenShare = {
		sourceId: selection.sourceId,
		audioMode: selection.audioMode,
		appAudioTargetId: selection.appAudioTargetId,
	};
};

const consumeScreenShareSelection = () => {
	const currentSelection = preparedScreenShare;
	preparedScreenShare = undefined;
	return currentSelection;
};

// Drop any armed source grant without consuming it. Needed because the macOS 15+
// native system picker bypasses the display-media handler, so a source prepared
// alongside useSystemPicker never gets consumed and would otherwise stay queued.
const clearPreparedScreenShareSelection = () => {
	preparedScreenShare = undefined;
};

// Capturing a thumbnail frame of every window is the slow part of enumeration,
// so the picker loads in two phases: this fast call skips thumbnails entirely
// (thumbnailSize 0) and only fetches window icons, which are cheap. The grid
// renders immediately from icon + title; thumbnails stream in via the separate
// getThumbnailSources() call below.
const getListSources = async () => {
	return desktopCapturer.getSources({
		types: ['screen', 'window'],
		fetchWindowIcons: true,
		thumbnailSize: { width: 0, height: 0 },
	});
};

const getThumbnailSources = async () => {
	return desktopCapturer.getSources({
		types: ['screen', 'window'],
		fetchWindowIcons: false,
		thumbnailSize: {
			width: 360,
			height: 210,
		},
	});
};

const isScreenSource = (source: DesktopCapturerSource) => {
	return source.id.startsWith('screen:');
};

const fallbackSourceName = (source: DesktopCapturerSource) => {
	const idSegments = source.id.split(':');

	if (isScreenSource(source)) {
		const displayIndex = Number.parseInt(idSegments[1] ?? '', 10);
		if (Number.isFinite(displayIndex)) {
			return `Display ${displayIndex + 1}`;
		}

		return 'Display';
	}

	const windowToken = idSegments[1];
	if (windowToken) {
		return `Window ${windowToken}`;
	}

	return 'Window';
};

const compareSources = (left: DesktopCapturerSource, right: DesktopCapturerSource) => {
	const leftKindOrder = isScreenSource(left) ? 0 : 1;
	const rightKindOrder = isScreenSource(right) ? 0 : 1;

	if (leftKindOrder !== rightKindOrder) {
		return leftKindOrder - rightKindOrder;
	}

	return left.name.localeCompare(right.name, undefined, {
		sensitivity: 'base',
		numeric: true,
	});
};

const imageToDataUrl = (image: NativeImage | undefined): string | undefined => {
	if (!image || image.isEmpty()) {
		return undefined;
	}

	return image.toDataURL();
};

// Phase 1: no thumbnail captured yet, so previewAvailable is optimistically
// true (the live thumbnail fetch resolves the real value). This keeps the
// picker from prematurely routing a window to the system-picker fallback before
// thumbnails have loaded.
const serializeListSource = (source: DesktopCapturerSource): TShareSource => {
	const normalizedName = source.name.trim();

	return {
		id: source.id,
		name: normalizedName || fallbackSourceName(source),
		kind: isScreenSource(source) ? 'screen' : 'window',
		previewAvailable: true,
		thumbnailDataUrl: '',
		appIconDataUrl: imageToDataUrl(source.appIcon),
	};
};

const serializeThumbnail = (source: DesktopCapturerSource): TShareSourceThumbnail => {
	const thumbnailDataUrl = imageToDataUrl(source.thumbnail);

	return {
		id: source.id,
		previewAvailable: thumbnailDataUrl !== undefined,
		thumbnailDataUrl: thumbnailDataUrl ?? '',
	};
};

const listShareSources = async (): Promise<TShareSource[]> => {
	const sources = await getListSources();
	return sources.sort(compareSources).map(serializeListSource);
};

const listShareSourceThumbnails = async (): Promise<TShareSourceThumbnail[]> => {
	const sources = await getThumbnailSources();
	return sources.map(serializeThumbnail);
};

const getSourceById = async (sourceId: string) => {
	const sources = await getListSources();
	return sources.find((source) => source.id === sourceId);
};

export {
	clearPreparedScreenShareSelection,
	consumeScreenShareSelection,
	getSourceById,
	listShareSources,
	listShareSourceThumbnails,
	prepareScreenShareSelection,
};
