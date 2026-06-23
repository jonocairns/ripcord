import type { Transport } from 'mediasoup-client/types';
import { useCallback, useEffect, useRef } from 'react';
import { logVoice } from '@/helpers/browser-logger';

export type TransportStats = {
	bytesReceived: number;
	bytesSent: number;
	packetsReceived: number;
	packetsSent: number;
	packetsLost: number;
	rtt: number;
	jitter: number;
	timestamp: number;
	outboundVideo: VideoSenderStats[];
	inboundVideo: VideoReceiverStats[];
};

export type VideoSenderStats = {
	id: string;
	label: string | null;
	codec: string | null;
	width: number | null;
	height: number | null;
	framesPerSecond: number | null;
	framesEncoded: number;
	framesSent: number;
	framesDropped: number | null;
	qualityLimitationReason: string | null;
	// 'D3D12VideoEncodeAccelerator' / 'NVENC' (hardware) vs 'libaom' / 'SimulcastEncoderAdapter'
	// (software). null when the browser doesn't report it.
	encoderImplementation: string | null;
	// True when the encode runs on a power-efficient (hardware) encoder.
	powerEfficientEncoder: boolean | null;
	// Configured per-encoding `maxBitrate` ceiling (bps), read from the sender's
	// RtpEncodingParameters and matched to this stream by ssrc. null when no
	// ceiling is configured or the ssrc couldn't be matched.
	configuredMaxBitrate: number | null;
	nackCount: number;
	pliCount: number;
	firCount: number;
	qpSum: number | null;
	hugeFramesSent: number;
};

export type VideoReceiverStats = {
	id: string;
	codec: string | null;
	width: number | null;
	height: number | null;
	framesPerSecond: number | null;
	framesDecoded: number;
	framesReceived: number;
	framesDropped: number;
	packetsLost: number;
	jitter: number;
};

export type TransportStatsData = {
	producer: TransportStats | null;
	consumer: TransportStats | null;
	totalBytesReceived: number;
	totalBytesSent: number;
	currentBitrateSent: number;
	currentBitrateReceived: number;
	averageBitrateSent: number;
	averageBitrateReceived: number;
	isMonitoring: boolean;
};

const SMOOTHING_WINDOW = 5; // Number of samples for moving average

const EMPTY_TRANSPORT_STATS: TransportStatsData = {
	producer: null,
	consumer: null,
	totalBytesReceived: 0,
	totalBytesSent: 0,
	currentBitrateSent: 0,
	currentBitrateReceived: 0,
	averageBitrateSent: 0,
	averageBitrateReceived: 0,
	isMonitoring: false,
};

// Stats samples land at 1 Hz for the whole voice session. Exposing them through
// React state in the voice provider re-rendered every context consumer once a
// second, so the data lives in a subscribe/snapshot store instead and only the
// components that actually display it (the stats popover) subscribe.
export type TransportStatsStore = {
	subscribe: (listener: () => void) => () => void;
	getSnapshot: () => TransportStatsData;
};

type TMutableTransportStatsStore = TransportStatsStore & {
	set: (updater: (previous: TransportStatsData) => TransportStatsData) => void;
};

const createTransportStatsStore = (): TMutableTransportStatsStore => {
	let snapshot = EMPTY_TRANSPORT_STATS;
	const listeners = new Set<() => void>();

	return {
		subscribe: (listener) => {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => snapshot,
		set: (updater) => {
			snapshot = updater(snapshot);

			listeners.forEach((listener) => {
				listener();
			});
		},
	};
};

// 'video/H264' -> 'H264'. Surfaces the codec actually negotiated on the wire,
// which can differ from the user's selection.
const shortCodecName = (mimeType: string | undefined): string | null => {
	if (!mimeType) {
		return null;
	}

	const slashIndex = mimeType.indexOf('/');

	return slashIndex === -1 ? mimeType : mimeType.slice(slashIndex + 1);
};

type VideoSenderMetadata = {
	configuredMaxBitrate: number | null;
	label: string;
};

type VideoSenderMetadataGetter = () => Map<number, VideoSenderMetadata>;

const isAuxiliaryVideoCodec = (codec: string | null): boolean => {
	return codec?.toLowerCase() === 'rtx';
};

const useTransportStats = (getVideoSenderMetadata?: VideoSenderMetadataGetter) => {
	const storeRef = useRef<TMutableTransportStatsStore | undefined>(undefined);

	if (!storeRef.current) {
		storeRef.current = createTransportStatsStore();
	}

	const store = storeRef.current;

	// Keep the latest getter in a ref so parseTransportStats (a []-dep callback)
	// always reads the current producers without re-creating the callback.
	const videoSenderMetadataGetterRef = useRef<VideoSenderMetadataGetter | undefined>(getVideoSenderMetadata);
	videoSenderMetadataGetterRef.current = getVideoSenderMetadata;

	const intervalRef = useRef<NodeJS.Timeout | null>(null);
	const producerTransportRef = useRef<Transport | null>(null);
	const consumerTransportRef = useRef<Transport | null>(null);
	const previousStatsRef = useRef<{
		producer: TransportStats | null;
		consumer: TransportStats | null;
	}>({
		producer: null,
		consumer: null,
	});

	// Rolling windows for smoothing bitrate
	const bitrateSentHistoryRef = useRef<number[]>([]);
	const bitrateReceivedHistoryRef = useRef<number[]>([]);

	const parseTransportStats = useCallback((statsReport: RTCStatsReport, isProducer: boolean): TransportStats | null => {
		let bytesReceived = 0;
		let bytesSent = 0;
		let packetsReceived = 0;
		let packetsSent = 0;
		let packetsLost = 0;
		let rtt = 0;
		let jitter = 0;
		const outboundVideo: VideoSenderStats[] = [];
		const inboundVideo: VideoReceiverStats[] = [];

		// Codec stats are separate entries referenced by codecId on the rtp stats,
		// and may appear in any order, so resolve them up front.
		const codecById = new Map<string, string>();

		for (const stat of statsReport.values()) {
			if (stat.type === 'codec' && typeof stat.mimeType === 'string') {
				codecById.set(stat.id, stat.mimeType);
			}
		}

		const resolveCodec = (codecId: string | undefined): string | null => {
			return shortCodecName(codecId ? codecById.get(codecId) : undefined);
		};

		const videoSenderMetadataBySsrc = isProducer ? videoSenderMetadataGetterRef.current?.() : undefined;

		for (const stat of statsReport.values()) {
			if (stat.type === 'outbound-rtp' && isProducer) {
				bytesSent += stat.bytesSent || 0;
				packetsSent += stat.packetsSent || 0;

				if (stat.kind === 'video') {
					const codec = resolveCodec(stat.codecId);

					if (isAuxiliaryVideoCodec(codec)) {
						continue;
					}

					const metadata = typeof stat.ssrc === 'number' ? videoSenderMetadataBySsrc?.get(stat.ssrc) : undefined;

					outboundVideo.push({
						id: stat.id,
						label: metadata?.label ?? null,
						codec,
						width: stat.frameWidth ?? null,
						height: stat.frameHeight ?? null,
						framesPerSecond: stat.framesPerSecond ?? null,
						framesEncoded: stat.framesEncoded ?? 0,
						framesSent: stat.framesSent ?? 0,
						framesDropped: stat.framesDropped ?? null,
						qualityLimitationReason: stat.qualityLimitationReason ?? null,
						encoderImplementation: stat.encoderImplementation ?? null,
						powerEfficientEncoder: stat.powerEfficientEncoder ?? null,
						configuredMaxBitrate: metadata?.configuredMaxBitrate ?? null,
						nackCount: stat.nackCount ?? 0,
						pliCount: stat.pliCount ?? 0,
						firCount: stat.firCount ?? 0,
						qpSum: stat.qpSum ?? null,
						hugeFramesSent: stat.hugeFramesSent ?? 0,
					});
				}
			} else if (stat.type === 'remote-inbound-rtp' && isProducer) {
				packetsLost += stat.packetsLost || 0;
				jitter += stat.jitter || 0;

				if (typeof stat.roundTripTime === 'number') {
					rtt = Math.max(rtt, stat.roundTripTime * 1000);
				}
			} else if (stat.type === 'inbound-rtp' && !isProducer) {
				bytesReceived += stat.bytesReceived || 0;
				packetsReceived += stat.packetsReceived || 0;
				packetsLost += stat.packetsLost || 0;
				jitter += stat.jitter || 0;

				if (stat.kind === 'video') {
					const codec = resolveCodec(stat.codecId);

					if (isAuxiliaryVideoCodec(codec)) {
						continue;
					}

					inboundVideo.push({
						id: stat.id,
						codec,
						width: stat.frameWidth ?? null,
						height: stat.frameHeight ?? null,
						framesPerSecond: stat.framesPerSecond ?? null,
						framesDecoded: stat.framesDecoded ?? 0,
						framesReceived: stat.framesReceived ?? 0,
						framesDropped: stat.framesDropped ?? 0,
						packetsLost: stat.packetsLost ?? 0,
						jitter: stat.jitter ?? 0,
					});
				}
			} else if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
				rtt = Math.max(rtt, (stat.currentRoundTripTime || 0) * 1000);
			}
		}

		return {
			bytesReceived,
			bytesSent,
			packetsReceived,
			packetsSent,
			packetsLost,
			rtt,
			jitter,
			timestamp: Date.now(),
			outboundVideo,
			inboundVideo,
		};
	}, []);

	const collectStats = useCallback(async () => {
		if (!producerTransportRef.current && !consumerTransportRef.current) {
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
				intervalRef.current = null;
			}

			store.set((prev) => ({
				...prev,
				isMonitoring: false,
			}));

			logVoice('Stopped transport stats monitoring (transports closed)');
			return;
		}

		try {
			let producerStats: TransportStats | null = null;
			let consumerStats: TransportStats | null = null;

			if (producerTransportRef.current) {
				try {
					const producerStatsReport = await producerTransportRef.current.getStats();

					producerStats = parseTransportStats(producerStatsReport, true);
				} catch {
					producerTransportRef.current = null;
				}
			}

			if (consumerTransportRef.current) {
				try {
					const consumerStatsReport = await consumerTransportRef.current.getStats();

					consumerStats = parseTransportStats(consumerStatsReport, false);
				} catch {
					consumerTransportRef.current = null;
				}
			}

			if (!producerTransportRef.current && !consumerTransportRef.current) {
				if (intervalRef.current) {
					clearInterval(intervalRef.current);
					intervalRef.current = null;
				}

				store.set((prev) => ({
					...prev,
					isMonitoring: false,
				}));

				logVoice('Stopped transport stats monitoring (all transports closed)');
				return;
			}

			const previousProducer = previousStatsRef.current.producer;
			const previousConsumer = previousStatsRef.current.consumer;

			const bytesReceivedDelta =
				consumerStats && previousConsumer ? consumerStats.bytesReceived - previousConsumer.bytesReceived : 0;

			const bytesSentDelta =
				producerStats && previousProducer ? producerStats.bytesSent - previousProducer.bytesSent : 0;

			let currentBitrateSent = 0;
			let currentBitrateReceived = 0;

			if (producerStats && previousProducer && bytesSentDelta > 0) {
				const timeDeltaSent = (producerStats.timestamp - previousProducer.timestamp) / 1000;

				if (timeDeltaSent > 0) {
					currentBitrateSent = (bytesSentDelta * 8) / timeDeltaSent;
				}
			}

			if (consumerStats && previousConsumer && bytesReceivedDelta > 0) {
				const timeDeltaReceived = (consumerStats.timestamp - previousConsumer.timestamp) / 1000;

				if (timeDeltaReceived > 0) {
					currentBitrateReceived = (bytesReceivedDelta * 8) / timeDeltaReceived;
				}
			}

			if (currentBitrateSent > 0) {
				bitrateSentHistoryRef.current.push(currentBitrateSent);

				if (bitrateSentHistoryRef.current.length > SMOOTHING_WINDOW) {
					bitrateSentHistoryRef.current.shift();
				}
			}

			if (currentBitrateReceived > 0) {
				bitrateReceivedHistoryRef.current.push(currentBitrateReceived);

				if (bitrateReceivedHistoryRef.current.length > SMOOTHING_WINDOW) {
					bitrateReceivedHistoryRef.current.shift();
				}
			}

			// Calculate moving averages
			const averageBitrateSent =
				bitrateSentHistoryRef.current.length > 0
					? bitrateSentHistoryRef.current.reduce((a, b) => a + b, 0) / bitrateSentHistoryRef.current.length
					: 0;

			const averageBitrateReceived =
				bitrateReceivedHistoryRef.current.length > 0
					? bitrateReceivedHistoryRef.current.reduce((a, b) => a + b, 0) / bitrateReceivedHistoryRef.current.length
					: 0;

			store.set((prev) => ({
				producer: producerStats,
				consumer: consumerStats,
				totalBytesReceived: prev.totalBytesReceived + bytesReceivedDelta,
				totalBytesSent: prev.totalBytesSent + bytesSentDelta,
				currentBitrateSent,
				currentBitrateReceived,
				averageBitrateSent,
				averageBitrateReceived,
				isMonitoring: true,
			}));

			previousStatsRef.current = {
				producer: producerStats,
				consumer: consumerStats,
			};
		} catch (error) {
			logVoice('Error collecting transport stats', { error });
		}
	}, [parseTransportStats, store]);

	const startMonitoring = useCallback(
		(producerTransport?: Transport | null, consumerTransport?: Transport | null, intervalMs: number = 1000) => {
			producerTransportRef.current = producerTransport || null;
			consumerTransportRef.current = consumerTransport || null;

			if (intervalRef.current) {
				clearInterval(intervalRef.current);
			}

			if (producerTransport || consumerTransport) {
				collectStats();
				intervalRef.current = setInterval(collectStats, intervalMs);
			}
		},
		[collectStats],
	);

	const stopMonitoring = useCallback(() => {
		if (intervalRef.current) {
			clearInterval(intervalRef.current);
			intervalRef.current = null;
		}

		producerTransportRef.current = null;
		consumerTransportRef.current = null;

		store.set((prev) => ({
			...prev,
			isMonitoring: false,
		}));

		logVoice('Stopped transport stats monitoring');
	}, [store]);

	const resetStats = useCallback(() => {
		store.set(() => EMPTY_TRANSPORT_STATS);

		previousStatsRef.current = {
			producer: null,
			consumer: null,
		};

		bitrateSentHistoryRef.current = [];
		bitrateReceivedHistoryRef.current = [];

		logVoice('Transport stats reset');
	}, [store]);

	useEffect(() => {
		window.printVoiceStats = () => {
			logVoice('Current Transport Stats:', { stats: store.getSnapshot() });
		};

		return () => {
			delete window.printVoiceStats;
		};
	}, [store]);

	useEffect(() => {
		return () => {
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
			}
		};
	}, []);

	// Expose only the read side; the collector keeps the mutable handle.
	const publicStore: TransportStatsStore = store;

	return {
		store: publicStore,
		startMonitoring,
		stopMonitoring,
		resetStats,
	};
};

export { EMPTY_TRANSPORT_STATS, isAuxiliaryVideoCodec, useTransportStats };
