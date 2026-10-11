import { StreamKind, type TStreamEventDetails } from '@sharkord/shared';
import { createStreamPlaybackPolicy } from './stream-playback-policy';

type TMonitorOptions = {
	consumer: {
		id: string;
		producerId: string;
		closed: boolean;
		paused: boolean;
		track: MediaStreamTrack;
		getStats: () => Promise<RTCStatsReport>;
	};
	remoteId: number;
	getVideoElement: () => HTMLVideoElement | null;
	transportConnected: () => boolean;
	emit: (event: TStreamEventDetails) => void;
	now?: () => number;
	schedule?: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
	cancel?: (timer: ReturnType<typeof setInterval>) => void;
};

const counter = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export const getVideoReceiverCounters = (report: RTCStatsReport) => {
	let bytesReceived: number | undefined;
	let framesReceived: number | undefined;
	let framesDecoded: number | undefined;
	report.forEach((entry: unknown) => {
		if (typeof entry !== 'object' || entry === null || !('type' in entry) || entry.type !== 'inbound-rtp') return;
		if (!(('kind' in entry && entry.kind === 'video') || ('mediaType' in entry && entry.mediaType === 'video'))) return;
		if ('bytesReceived' in entry) bytesReceived = counter(entry.bytesReceived);
		if ('framesReceived' in entry) framesReceived = counter(entry.framesReceived);
		if ('framesDecoded' in entry) framesDecoded = counter(entry.framesDecoded);
	});
	return { bytesReceived, framesReceived, framesDecoded };
};

export const monitorScreenPlayback = (options: TMonitorOptions): (() => void) => {
	const policy = createStreamPlaybackPolicy();
	const now = options.now ?? Date.now;
	let disposed = false;
	let sampling = false;
	let observedVideo: HTMLVideoElement | null = null;
	let frameCallback: number | undefined;
	let renderedFrames = 0;
	const detachVideo = () => {
		if (frameCallback !== undefined) observedVideo?.cancelVideoFrameCallback?.(frameCallback);
		frameCallback = undefined;
		observedVideo = null;
	};
	const observeVideo = (video: HTMLVideoElement | null) => {
		if (video === observedVideo) return;
		detachVideo();
		observedVideo = video;
		const onFrame = () => {
			if (disposed || observedVideo !== video || !video) return;
			renderedFrames += 1;
			frameCallback = video.requestVideoFrameCallback(onFrame);
		};
		if (video?.requestVideoFrameCallback) frameCallback = video.requestVideoFrameCallback(onFrame);
	};
	const sample = async () => {
		if (disposed || sampling || options.consumer.closed) return;
		sampling = true;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const report = await Promise.race([
				options.consumer.getStats(),
				new Promise<undefined>((resolve) => {
					timeout = setTimeout(() => resolve(undefined), 5_000);
				}),
			]);
			if (disposed || options.consumer.closed) return;
			const video = options.getVideoElement();
			const ownsVideo =
				!!video &&
				typeof MediaStream !== 'undefined' &&
				video.srcObject instanceof MediaStream &&
				video.srcObject.getVideoTracks().some((track) => track.id === options.consumer.track.id);
			observeVideo(ownsVideo ? video : null);
			const style = video?.ownerDocument.defaultView?.getComputedStyle(video);
			const eligible =
				!!video &&
				ownsVideo &&
				video.isConnected &&
				video.getClientRects().length > 0 &&
				video.ownerDocument.visibilityState === 'visible' &&
				style?.visibility === 'visible' &&
				Number(style.opacity) > 0 &&
				!video.paused &&
				!video.ended &&
				!options.consumer.paused &&
				options.consumer.track.readyState === 'live';
			const events = policy({
				now: now(),
				eligible,
				transportConnected: options.transportConnected(),
				framesRendered: video?.requestVideoFrameCallback ? renderedFrames : undefined,
				...(report ? getVideoReceiverCounters(report) : {}),
			});
			for (const event of events)
				options.emit({
					...event,
					kind: StreamKind.SCREEN,
					remoteId: options.remoteId,
					consumerId: options.consumer.id,
					producerId: options.consumer.producerId,
				});
		} catch {
			/* Stats unsupported/failure is not a playback diagnosis. */
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			sampling = false;
		}
	};
	const interval = (options.schedule ?? setInterval)(() => {
		void sample();
	}, 3_000);
	void sample();
	return () => {
		disposed = true;
		(options.cancel ?? clearInterval)(interval);
		detachVideo();
	};
};
