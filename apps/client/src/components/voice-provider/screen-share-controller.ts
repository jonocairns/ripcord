import { StreamKind } from '@sharkord/shared';
import type { AppData, Producer, RtpCapabilities, Transport } from 'mediasoup-client/types';
import { getResWidthHeight } from '@/helpers/get-res-with-height';
import { normalizeDesktopCapabilities } from '@/runtime/desktop-capabilities';
import {
	ScreenAudioMode,
	type TDesktopBridge,
	type TDesktopCapabilities,
	type TDesktopScreenShareSelection,
	type TDesktopShareSource,
	type TStartAppAudioCaptureInput,
} from '@/runtime/types';
import type { TDeviceSettings } from '@/types';
import { VoiceSessionExecutionSupersededError } from './hooks/session-execution-ownership';
import { mountScreenShareQualityGuard } from './screen-share-quality-guard';
import type { TShareAudioController } from './share-audio-controller';
import { applyVideoDegradationPreference, getScreenShareVideoProducerConfig } from './video-producer-config';

type TScreenShareStreamHandlers = {
	onVideoTrackStarted?: () => void;
	onVideoTrackEnded?: () => void | Promise<void>;
};
type TScreenShareDependencies = {
	getDevices: () => TDeviceSettings;
	getProducerTransport: () => Transport<AppData> | undefined;
	getRtpCapabilities: () => RtpCapabilities | null;
	getDesktopBridge: () => TDesktopBridge | undefined;
	acquire: (options: DisplayMediaStreamOptions) => Promise<MediaStream>;
	requestSelection: (input: {
		defaultAudioMode: ScreenAudioMode;
		loadData: () => Promise<{ sources: TDesktopShareSource[]; capabilities: TDesktopCapabilities }>;
	}) => Promise<TDesktopScreenShareSelection | null>;
	publishStream: (stream: MediaStream | undefined) => void;
	closeProducer: (producerId: string) => void;
	shareAudio: Pick<TShareAudioController, 'stop' | 'awaitTeardown' | 'adoptDisplayAudio' | 'start'>;
	warning: (message: string) => void;
	log: (message: string, data?: Record<string, unknown>) => void;
	setInterval: (handler: () => void, delayMs: number) => ReturnType<typeof setInterval>;
	clearInterval: (handle: ReturnType<typeof setInterval>) => void;
	now: () => number;
};
const createScreenShareController = (deps: TScreenShareDependencies) => {
	let stream: MediaStream | undefined;
	let producer: Producer<AppData> | undefined;
	let onTrackEnded: (() => void | Promise<void>) | undefined;
	const setStream = (next: MediaStream | undefined) => {
		stream = next;
		deps.publishStream(next);
	};
	const detachProducer = () => {
		const previous = producer;
		producer = undefined;
		previous?.close();
	};
	const stop = () => {
		stream?.getVideoTracks().forEach((track) => {
			track.stop();
			stream?.removeTrack(track);
		});
		detachProducer();
		onTrackEnded = undefined;
		void deps.shareAudio.stop();
		setStream(undefined);
	};
	const publish = async (
		capture: MediaStream,
		track: MediaStreamTrack,
		options: {
			onTrackEnded?: () => void | Promise<void>;
			clearStreamOnFailure?: boolean;
			isCurrent?: () => boolean;
		} = {},
	) => {
		const transport = deps.getProducerTransport();
		if (!transport || transport.closed || (options.isCurrent && !options.isCurrent()))
			throw new VoiceSessionExecutionSupersededError();
		setStream(capture);
		if (options.onTrackEnded) onTrackEnded = options.onTrackEnded;
		const endedHandler = onTrackEnded;
		let created: Producer<AppData> | undefined;
		try {
			track.contentHint = 'motion';
			const devices = deps.getDevices();
			const requested = getResWidthHeight(devices.screenResolution);
			const settings = track.getSettings();
			created = await transport.produce({
				track,
				stopTracks: false,
				appData: { kind: StreamKind.SCREEN },
				...getScreenShareVideoProducerConfig({
					rtpCapabilities: deps.getRtpCapabilities(),
					preference: devices.videoCodec,
					width: settings.width ?? requested.width,
					height: settings.height ?? requested.height,
					frameRate: settings.frameRate ?? devices.screenFramerate,
				}),
			});
			if (!created) throw new Error('Failed to create screen share producer');
			const published = created;
			await applyVideoDegradationPreference(published.rtpSender, 'screen share');
			if (deps.getProducerTransport() !== transport || transport.closed || (options.isCurrent && !options.isCurrent()))
				throw new VoiceSessionExecutionSupersededError();
			producer = published;
			published.on('@close', () => {
				if (producer === published) producer = undefined;
				deps.closeProducer(published.id);
			});
			track.onended = () => {
				capture.getVideoTracks().forEach((current) => current.stop());
				published.close();
				void deps.shareAudio.stop();
				setStream(undefined);
				void endedHandler?.();
			};
		} catch (error) {
			created?.close();
			if (producer === created) producer = undefined;
			if (options.clearStreamOnFailure ?? true) {
				capture.getVideoTracks().forEach((current) => current.stop());
				if (stream === capture) setStream(undefined);
			}
			throw error;
		}
	};
	const requestSelection = () =>
		deps.requestSelection({
			defaultAudioMode: deps.getDevices().screenAudioMode,
			loadData: async () => {
				const bridge = deps.getDesktopBridge();
				if (!bridge) throw new Error('Desktop bridge unavailable');
				const [sources, capabilities] = await Promise.all([bridge.listShareSources(), bridge.getCapabilities()]);
				return { sources, capabilities: normalizeDesktopCapabilities(capabilities) };
			},
		});
	const start = async (
		desktopSelection?: TDesktopScreenShareSelection,
		handlers: TScreenShareStreamHandlers = {},
	): Promise<MediaStreamTrack> => {
		const devices = deps.getDevices();
		// Wait for any in-flight desktop audio cleanup from a previous screen
		// share stop so the new sidecar session doesn't conflict with it.
		await deps.shareAudio.awaitTeardown();

		let stream: MediaStream | undefined;

		try {
			deps.log('Starting screen share stream');

			let audioMode = devices.screenAudioMode;
			const desktopBridge = deps.getDesktopBridge();

			if (desktopBridge && desktopSelection) {
				const resolved = await desktopBridge.prepareScreenShare(desktopSelection);
				audioMode = resolved.effectiveMode;

				if (resolved.warning) {
					deps.warning(resolved.warning);
				}
			}

			// Only route system audio through the sidecar when the desktop
			// capture stack advertises support for the sidecar-backed path.
			// Linux uses a best-effort PipeWire mix with self-exclusion, and
			// macOS uses the ScreenCaptureKit helper-backed sidecar path.
			let sidecarSupported = false;
			if (desktopBridge && audioMode === ScreenAudioMode.SYSTEM) {
				try {
					const caps = normalizeDesktopCapabilities(await desktopBridge.getCapabilities());
					sidecarSupported = caps.sidecarAvailable === true && caps.perAppAudio !== 'unsupported';
				} catch {
					// If capabilities check fails, don't attempt sidecar for system audio.
				}
			}

			const sidecarAudioMode =
				audioMode === ScreenAudioMode.APP || (audioMode === ScreenAudioMode.SYSTEM && sidecarSupported)
					? audioMode
					: undefined;
			const useSidecarAudio = desktopBridge && desktopSelection && sidecarAudioMode !== undefined;

			// Always request loopback audio from getDisplayMedia in system mode
			// so it is available as a fallback if the sidecar fails.  When the
			// sidecar successfully captures audio, the loopback track is stopped
			// and removed before the producer is created.
			const shouldCaptureDisplayAudio = audioMode === ScreenAudioMode.SYSTEM;
			const requestedScreenResolution = getResWidthHeight(devices?.screenResolution);

			try {
				stream = await deps.acquire({
					video: {
						...requestedScreenResolution,
						frameRate: devices?.screenFramerate,
					},
					audio: shouldCaptureDisplayAudio
						? {
								echoCancellation: false,
								noiseSuppression: false,
								autoGainControl: false,
							}
						: false,
				});
			} finally {
				if (desktopSelection?.useSystemPicker) {
					void desktopBridge?.resetScreenSharePicker?.();
				}
			}

			deps.shareAudio.adoptDisplayAudio(stream);
			deps.log('Screen share stream obtained', { stream });

			const videoTrack = stream.getVideoTracks()[0];

			if (videoTrack) {
				await publish(stream, videoTrack, {
					onTrackEnded: handlers.onVideoTrackEnded,
				});
				// Surface the active share as soon as the video producer exists.
				// Optional audio setup can continue after the preview is already live.
				handlers.onVideoTrackStarted?.();

				if (useSidecarAudio && desktopBridge && desktopSelection && sidecarAudioMode) {
					const captureInput: TStartAppAudioCaptureInput = {
						sourceId: desktopSelection.sourceId,
					};

					if (sidecarAudioMode === ScreenAudioMode.APP) {
						captureInput.appAudioTargetId = desktopSelection.appAudioTargetId;
					}

					await deps.shareAudio.start({
						displayStream: stream,
						desktopBridge,
						captureInput,
						audioMode: sidecarAudioMode,
					});
				} else {
					await deps.shareAudio.start({ displayStream: stream });
				}

				return videoTrack;
			} else {
				throw new Error('No video track obtained for screen share');
			}
		} catch (error) {
			stream?.getVideoTracks().forEach((track) => {
				track.stop();
			});
			await deps.shareAudio.stop();

			deps.log('Error starting screen share stream', { error });
			throw error;
		}
	};
	const republish = (isCurrent?: () => boolean): Promise<void> | undefined => {
		const capture = stream;
		const track = capture?.getVideoTracks()[0];
		if (capture && track?.readyState === 'live')
			return publish(capture, track, { clearStreamOnFailure: false, isCurrent });
	};
	const getProducer = () => producer;
	const mountQualityGuard = () => mountScreenShareQualityGuard({ ...deps, getProducer });
	return {
		start,
		stop,
		detachProducer,
		republish,
		requestSelection,
		mountQualityGuard,
		getProducer,
		getStream: () => stream,
		isLive: () => (producer?.track ?? stream?.getVideoTracks()[0])?.readyState === 'live',
	};
};
const mountScreenShareController = (controller: ReturnType<typeof createScreenShareController>) => {
	const disposeGuard = controller.mountQualityGuard();
	return () => {
		disposeGuard();
		controller.stop();
	};
};

export { createScreenShareController, mountScreenShareController, type TScreenShareDependencies };
