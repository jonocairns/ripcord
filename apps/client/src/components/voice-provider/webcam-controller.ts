import { StreamKind } from '@sharkord/shared';
import type { AppData, Producer, RtpCapabilities, Transport } from 'mediasoup-client/types';
import { getResWidthHeight } from '@/helpers/get-res-with-height';
import type { TDeviceSettings } from '@/types';
import { VoiceSessionExecutionSupersededError } from './hooks/session-execution-ownership';
import { applyVideoDegradationPreference, getWebcamVideoProducerConfig } from './video-producer-config';

type TWebcamDependencies = {
	getDevices: () => TDeviceSettings;
	getProducerTransport: () => Transport<AppData> | undefined;
	getRtpCapabilities: () => RtpCapabilities | null;
	acquire: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	publishStream: (stream: MediaStream | undefined) => void;
	closeProducer: (producerId: string) => void;
	onTrackEnded: () => void;
	log: (message: string, data?: Record<string, unknown>) => void;
};

const didWebcamCaptureSettingsChange = (previous: TDeviceSettings, next: TDeviceSettings) =>
	previous.webcamId !== next.webcamId ||
	previous.webcamResolution !== next.webcamResolution ||
	previous.webcamFramerate !== next.webcamFramerate ||
	previous.videoCodec !== next.videoCodec;

const createWebcamController = (deps: TWebcamDependencies) => {
	let active = false;
	let generation = 0;
	let stream: MediaStream | undefined;
	let producer: Producer<AppData> | undefined;
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
			if (
				!transport ||
				transport.closed ||
				track.readyState !== 'live' ||
				(options.isCurrent && !options.isCurrent())
			) {
				throw new VoiceSessionExecutionSupersededError();
			}
			track.contentHint = 'motion';
			const devices = deps.getDevices();
			const requested = getResWidthHeight(devices.webcamResolution);
			const settings = track.getSettings();
			created = await transport.produce({
				track,
				stopTracks: false,
				appData: { kind: StreamKind.VIDEO },
				...getWebcamVideoProducerConfig({
					rtpCapabilities: deps.getRtpCapabilities(),
					preference: devices.videoCodec,
					width: settings.width ?? requested.width,
					height: settings.height ?? requested.height,
					frameRate: settings.frameRate ?? devices.webcamFramerate,
				}),
			});
			if (!created) throw new Error('Failed to create webcam producer');
			const published = created;
			// Register allocation cleanup before the awaited sender configuration, so a
			// late producer is also closed on the server even when never installed locally.
			published.on('@close', () => {
				if (producer === published) producer = undefined;
				deps.closeProducer(published.id);
			});
			assertCurrent(ownedGeneration);
			await applyVideoDegradationPreference(published.rtpSender, 'webcam');
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
		} catch (error) {
			created?.close();
			// A detach/republish may have taken responsibility for this same capture.
			// Failed recovery publication never stops the surviving track.
			if (!options.preserveCapture && generation === ownedGeneration && stream === capture) releaseCapture();
			throw error;
		}
	};
	const start = async () => {
		if (!active) throw new VoiceSessionExecutionSupersededError();
		const ownedGeneration = ++generation;
		releaseCapture();
		let capture: MediaStream | undefined;
		try {
			const devices = deps.getDevices();
			capture = await deps.acquire({
				audio: false,
				video: {
					...(devices.webcamId ? { deviceId: { exact: devices.webcamId } } : {}),
					frameRate: devices.webcamFramerate,
					...getResWidthHeight(devices.webcamResolution),
				},
			});
			assertCurrent(ownedGeneration);
			const track = capture.getVideoTracks()[0];
			if (track?.readyState !== 'live') throw new Error('Failed to obtain video track from webcam');
			const ownedCapture = capture;
			setStream(ownedCapture);
			// Capture identity, rather than a producer or session-command lease, keeps
			// native track loss effective during detach, failed republish and recovery.
			track.onended = () => {
				if (!active || stream !== ownedCapture || stream.getVideoTracks()[0] !== track) return;
				stop();
				deps.onTrackEnded();
			};
			await publish(ownedCapture, track, ownedGeneration);
			assertCurrent(ownedGeneration);
		} catch (error) {
			if (capture && stream !== capture)
				capture.getVideoTracks().forEach((track) => {
					track.onended = null;
					track.stop();
				});
			deps.log('Error starting webcam stream', { error });
			throw error;
		}
	};
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
		activate,
		deactivate,
		restart: async () => {
			stop();
			await start();
		},
		getProducer: () => producer,
		getStream: () => stream,
		isLive: () => stream?.getVideoTracks()[0]?.readyState === 'live',
	};
};
const mountWebcamController = (controller: ReturnType<typeof createWebcamController>) => {
	controller.activate();
	let mounted = true;
	return () => {
		if (!mounted) return;
		mounted = false;
		controller.deactivate();
	};
};

export { createWebcamController, didWebcamCaptureSettingsChange, mountWebcamController, type TWebcamDependencies };
