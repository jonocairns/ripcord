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
	shareAudio: Pick<
		TShareAudioController,
		'stop' | 'awaitTeardown' | 'adoptDisplayAudio' | 'discardDisplayAudio' | 'start'
	>;
	warning: (message: string) => void;
	log: (message: string, data?: Record<string, unknown>) => void;
	setInterval: (handler: () => void, delayMs: number) => ReturnType<typeof setInterval>;
	clearInterval: (handle: ReturnType<typeof setInterval>) => void;
	now: () => number;
};
const createScreenShareController = (deps: TScreenShareDependencies) => {
	let active = false;
	let generation = 0;
	let stream: MediaStream | undefined;
	let producer: Producer<AppData> | undefined;
	let disposeQualityGuard: (() => void) | undefined;
	const setStream = (next: MediaStream | undefined) => {
		stream = next;
		deps.publishStream(next);
	};
	const closeCurrentProducer = () => {
		const previous = producer;
		producer = undefined;
		previous?.close();
	};
	const releaseCapture = () => {
		disposeQualityGuard?.();
		disposeQualityGuard = undefined;
		const capture = stream;
		stream = undefined;
		capture?.getVideoTracks().forEach((track) => {
			track.onended = null;
			track.stop();
			capture.removeTrack(track);
		});
		closeCurrentProducer();
		setStream(undefined);
	};
	const stop = () => {
		++generation;
		releaseCapture();
		void deps.shareAudio.stop();
	};
	const detachProducer = () => {
		++generation;
		closeCurrentProducer();
	};
	const assertCurrent = (ownedGeneration: number) => {
		if (!active || generation !== ownedGeneration) throw new VoiceSessionExecutionSupersededError();
	};
	const publish = async (
		capture: MediaStream,
		track: MediaStreamTrack,
		ownedGeneration: number,
		options: { preserveCapture?: boolean; isCurrent?: () => boolean } = {},
	) => {
		let created: Producer<AppData> | undefined;
		try {
			assertCurrent(ownedGeneration);
			const transport = deps.getProducerTransport();
			if (!transport || transport.closed || track.readyState !== 'live' || (options.isCurrent && !options.isCurrent()))
				throw new VoiceSessionExecutionSupersededError();
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
			published.on('@close', () => {
				if (producer === published) producer = undefined;
				deps.closeProducer(published.id);
			});
			assertCurrent(ownedGeneration);
			await applyVideoDegradationPreference(published.rtpSender, 'screen share');
			assertCurrent(ownedGeneration);
			if (
				deps.getProducerTransport() !== transport ||
				transport.closed ||
				track.readyState !== 'live' ||
				stream !== capture ||
				(options.isCurrent && !options.isCurrent())
			)
				throw new VoiceSessionExecutionSupersededError();
			closeCurrentProducer();
			producer = published;
			disposeQualityGuard ??= mountScreenShareQualityGuard({ ...deps, getProducer });
		} catch (error) {
			created?.close();
			if (!options.preserveCapture && generation === ownedGeneration && stream === capture) releaseCapture();
			throw error;
		}
	};
	const requestSelection = async () => {
		const ownedGeneration = generation;
		const selection = await deps.requestSelection({
			defaultAudioMode: deps.getDevices().screenAudioMode,
			loadData: async () => {
				const bridge = deps.getDesktopBridge();
				if (!bridge) throw new Error('Desktop bridge unavailable');
				const [sources, capabilities] = await Promise.all([bridge.listShareSources(), bridge.getCapabilities()]);
				return { sources, capabilities: normalizeDesktopCapabilities(capabilities) };
			},
		});
		return active && generation === ownedGeneration ? selection : null;
	};
	const start = async (
		desktopSelection?: TDesktopScreenShareSelection,
		handlers: TScreenShareStreamHandlers = {},
	): Promise<MediaStreamTrack> => {
		if (!active) throw new VoiceSessionExecutionSupersededError();
		const ownedGeneration = ++generation;
		if (stream) {
			releaseCapture();
			void deps.shareAudio.stop();
		}
		const devices = deps.getDevices();
		// Wait for any in-flight desktop audio cleanup from a previous screen
		// share stop so the new sidecar session doesn't conflict with it.
		await deps.shareAudio.awaitTeardown();
		assertCurrent(ownedGeneration);

		let capture: MediaStream | undefined;

		try {
			deps.log('Starting screen share capture');

			let audioMode = devices.screenAudioMode;
			const desktopBridge = deps.getDesktopBridge();

			if (desktopBridge && desktopSelection) {
				const resolved = await desktopBridge.prepareScreenShare(desktopSelection);
				assertCurrent(ownedGeneration);
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

			assertCurrent(ownedGeneration);
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
				capture = await deps.acquire({
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

			assertCurrent(ownedGeneration);
			deps.shareAudio.adoptDisplayAudio(capture);
			deps.log('Screen share capture obtained', { capture });

			const videoTrack = capture.getVideoTracks()[0];

			if (videoTrack) {
				const ownedCapture = capture;
				setStream(ownedCapture);
				videoTrack.onended = () => {
					if (!active || getStream() !== ownedCapture || ownedCapture.getVideoTracks()[0] !== videoTrack) return;
					stop();
					void handlers.onVideoTrackEnded?.();
				};
				await publish(ownedCapture, videoTrack, ownedGeneration);
				assertCurrent(ownedGeneration);
				// Surface the active share as soon as the video producer exists.
				// Optional audio setup can continue after the preview is already live.
				handlers.onVideoTrackStarted?.();
				assertCurrent(ownedGeneration);

				if (useSidecarAudio && desktopBridge && desktopSelection && sidecarAudioMode) {
					const captureInput: TStartAppAudioCaptureInput = {
						sourceId: desktopSelection.sourceId,
					};

					if (sidecarAudioMode === ScreenAudioMode.APP) {
						captureInput.appAudioTargetId = desktopSelection.appAudioTargetId;
					}

					await deps.shareAudio.start({
						displayStream: capture,
						desktopBridge,
						captureInput,
						audioMode: sidecarAudioMode,
					});
				} else {
					await deps.shareAudio.start({ displayStream: capture });
				}

				assertCurrent(ownedGeneration);
				return videoTrack;
			} else {
				throw new Error('No video track obtained for screen share');
			}
		} catch (error) {
			if (capture && getStream() !== capture) {
				capture.getVideoTracks().forEach((track) => {
					track.onended = null;
					track.stop();
				});
				// Audio's scoped disposal also covers late mixed-stream acquisition that
				// was never adopted. It cannot clear or stop a replacement audio session.
				deps.shareAudio.discardDisplayAudio(capture);
			}
			if (generation === ownedGeneration) {
				releaseCapture();
				await deps.shareAudio.stop();
			}
			deps.log('Error starting screen share stream', { error });
			throw error;
		}
	};

	const getStream = () => stream;
	const republish = (isCurrent?: () => boolean): Promise<void> | undefined => {
		const capture = stream;
		const track = capture?.getVideoTracks()[0];
		if (capture && track?.readyState === 'live') {
			if (!active || (isCurrent && !isCurrent())) return Promise.reject(new VoiceSessionExecutionSupersededError());
			const ownedGeneration = ++generation;
			closeCurrentProducer();
			return publish(capture, track, ownedGeneration, { preserveCapture: true, isCurrent });
		}
	};
	const getProducer = () => producer;
	const activate = () => {
		active = true;
	};
	const deactivate = () => {
		active = false;
		stop();
	};
	return {
		start,
		stop,
		detachProducer,
		republish,
		requestSelection,
		activate,
		deactivate,
		getProducer,
		getStream,
		isLive: () => (producer?.track ?? stream?.getVideoTracks()[0])?.readyState === 'live',
	};
};
const mountScreenShareController = (controller: ReturnType<typeof createScreenShareController>) => {
	controller.activate();
	let mounted = true;
	return () => {
		if (!mounted) return;
		mounted = false;
		controller.deactivate();
	};
};

export { createScreenShareController, mountScreenShareController, type TScreenShareDependencies };
