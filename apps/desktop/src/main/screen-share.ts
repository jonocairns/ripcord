import { type DesktopCapturerSource, desktopCapturer, type NativeImage } from 'electron';
import type { TPreparedScreenShare, TScreenShareSelection, TShareSource } from './types';

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

// Enumeration is deliberately capture-free. Requesting source thumbnails runs
// every open window through the WGC capturer (enabled for live capture in #204),
// which can crash the GPU process — and take the whole app down — when a window
// is mid-swapchain-recreate, e.g. a hardware-decoding player playing a stream
// that rebuffers/resizes. So this fetches window icons only (cheap, no GPU
// capture) via thumbnailSize 0; the grid renders from icon + title. Real frames
// are produced by the live capture once a source is selected.
const getListSources = async () => {
	return desktopCapturer.getSources({
		types: ['screen', 'window'],
		fetchWindowIcons: true,
		thumbnailSize: { width: 0, height: 0 },
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

const serializeListSource = (source: DesktopCapturerSource): TShareSource => {
	const normalizedName = source.name.trim();

	return {
		id: source.id,
		name: normalizedName || fallbackSourceName(source),
		kind: isScreenSource(source) ? 'screen' : 'window',
		appIconDataUrl: imageToDataUrl(source.appIcon),
	};
};

const listShareSources = async (): Promise<TShareSource[]> => {
	const sources = await getListSources();
	return sources.sort(compareSources).map(serializeListSource);
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
	prepareScreenShareSelection,
};
