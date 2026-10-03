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
	let stream: MediaStream | undefined;
	let producer: Producer<AppData> | undefined;
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
		deps.log('Stopping webcam stream');
		stream?.getVideoTracks().forEach((track) => {
			track.stop();
			stream?.removeTrack(track);
		});
		detachProducer();
		setStream(undefined);
	};
	const publish = async (
		capture: MediaStream,
		track: MediaStreamTrack,
		options: { stopTracksOnFailure?: boolean; isCurrent?: () => boolean } = {},
	) => {
		const transport = deps.getProducerTransport();
		if (!transport || transport.closed || (options.isCurrent && !options.isCurrent())) {
			throw new VoiceSessionExecutionSupersededError();
		}
		setStream(capture);
		let created: Producer<AppData> | undefined;
		try {
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
			await applyVideoDegradationPreference(published.rtpSender, 'webcam');
			if (
				deps.getProducerTransport() !== transport ||
				transport.closed ||
				(options.isCurrent && !options.isCurrent())
			) {
				throw new VoiceSessionExecutionSupersededError();
			}
			producer = published;
			published.on('@close', () => {
				if (producer === published) producer = undefined;
				deps.closeProducer(published.id);
			});
			track.onended = () => {
				capture.getVideoTracks().forEach((current) => current.stop());
				published.close();
				if (stream === capture) setStream(undefined);
				deps.onTrackEnded();
			};
		} catch (error) {
			created?.close();
			if (producer === created) producer = undefined;
			if (options.stopTracksOnFailure ?? true) {
				capture.getVideoTracks().forEach((current) => current.stop());
				if (stream === capture) setStream(undefined);
			}
			throw error;
		}
	};
	const start = async () => {
		try {
			const devices = deps.getDevices();
			const capture = await deps.acquire({
				audio: false,
				video: {
					...(devices.webcamId ? { deviceId: { exact: devices.webcamId } } : {}),
					frameRate: devices.webcamFramerate,
					...getResWidthHeight(devices.webcamResolution),
				},
			});
			const track = capture.getVideoTracks()[0];
			if (!track) throw new Error('Failed to obtain video track from webcam');
			await publish(capture, track);
		} catch (error) {
			deps.log('Error starting webcam stream', { error });
			throw error;
		}
	};
	const republish = (isCurrent?: () => boolean): Promise<void> | undefined => {
		const capture = stream;
		const track = capture?.getVideoTracks()[0];
		if (capture && track?.readyState === 'live')
			return publish(capture, track, { stopTracksOnFailure: false, isCurrent });
	};
	return {
		start,
		stop,
		detachProducer,
		republish,
		restart: async () => {
			stop();
			await start();
		},
		getProducer: () => producer,
		getStream: () => stream,
		isLive: () => stream?.getVideoTracks()[0]?.readyState === 'live',
	};
};
const mountWebcamController = (controller: ReturnType<typeof createWebcamController>) => () => controller.stop();

export { createWebcamController, didWebcamCaptureSettingsChange, mountWebcamController, type TWebcamDependencies };
