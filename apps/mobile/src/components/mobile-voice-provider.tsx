import {
	clearPendingVoiceReconnectChannelId,
	currentVoiceChannelIdSelector,
	getPendingVoiceReconnectChannelId,
	getPendingVoiceReconnectRetryCount,
	getTRPCClient,
	incrementPendingVoiceReconnectRetryCount,
	ownVoiceStateSelector,
	useServerStore,
} from '@sharkord/app-core';
import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared/src/types';
import type { TTransportParams } from '@sharkord/shared/src/voice';
import { TRPCClientError } from '@trpc/client';
import { Device } from 'mediasoup-client';
import type { AppData, Consumer, Producer, RtpCapabilities, Transport } from 'mediasoup-client/types';
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ComponentType,
	type PropsWithChildren,
} from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

type TWebRTCMediaStream = {
	getAudioTracks: () => MediaStreamTrack[];
	getTracks: () => MediaStreamTrack[];
	toURL: () => string;
};

type TMediaStreamConstructor = new (stream?: TWebRTCMediaStream | MediaStreamTrack[]) => TWebRTCMediaStream;

type TRTCViewProps = {
	mirror?: boolean;
	objectFit?: 'contain' | 'cover';
	streamURL: string;
	style?: StyleProp<ViewStyle>;
	zOrder?: number;
};

type TPermissionsModule = {
	RESULT: {
		GRANTED: string;
	};
	request: (permissionDesc: { name: string }) => Promise<boolean | string>;
};

type TRTCViewComponent = ComponentType<TRTCViewProps>;

type TRemoteAudioRenderer = {
	remoteUserId: number;
	streamURL: string;
};

type TWebRTCModule = {
	MediaStream: TMediaStreamConstructor;
	RTCView: TRTCViewComponent;
	mediaDevices: {
		getUserMedia: (constraints: { audio: boolean; video: boolean }) => Promise<TWebRTCMediaStream>;
	};
	permissions: TPermissionsModule;
	registerGlobals: () => void;
};

type TConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

type TJoinResult = 'joined' | 'already-joined' | 'retryable-failure' | 'non-retriable-failure';

type TConsumeAudioOptions = {
	rtpCapabilities: RtpCapabilities;
	remoteUserId: number;
};

type TJoinChannelOptions = {
	playJoinSound?: boolean;
};

type TLeaveChannelOptions = {
	clearPendingReconnect?: boolean;
	notifyServer?: boolean;
};

type TMobileVoiceContextValue = {
	connectionStatus: TConnectionStatus;
	errorMessage: string | undefined;
	isBusy: boolean;
	joinChannel: (channelId: number, options?: TJoinChannelOptions) => Promise<TJoinResult>;
	leaveChannel: () => Promise<void>;
	setMicMuted: (muted: boolean) => Promise<void>;
	setSoundMuted: (muted: boolean) => Promise<void>;
};

type TVoiceSubscriptions = {
	onNewProducer?: { unsubscribe: () => void };
	onProducerClosed?: { unsubscribe: () => void };
	onUserLeave?: { unsubscribe: () => void };
};

const AUDIO_OPUS_CODEC_OPTIONS = {
	opusDtx: false,
	opusFec: true,
	opusMaxAverageBitrate: 128_000,
	opusPacketLossPerc: 15,
} as const;
const MAX_VOICE_REJOIN_RETRIES = 5;
const VOICE_REJOIN_RETRY_DELAY_MS = 2_000;

const MobileVoiceContext = createContext<TMobileVoiceContextValue | null>(null);

let cachedWebRTCModulePromise: Promise<TWebRTCModule> | null = null;

const getErrorMessage = (error: unknown, fallback: string): string => {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	return fallback;
};

const toError = (error: unknown, fallback: string): Error => {
	return error instanceof Error ? error : new Error(fallback);
};

const isNonRetriableJoinError = (error: unknown): boolean => {
	if (!(error instanceof TRPCClientError)) {
		return false;
	}

	return (
		error.data?.code === 'BAD_REQUEST' ||
		error.data?.code === 'FORBIDDEN' ||
		error.data?.code === 'NOT_FOUND' ||
		error.data?.code === 'UNAUTHORIZED'
	);
};

const isWebRTCModule = (value: unknown): value is TWebRTCModule => {
	return (
		typeof value === 'object' &&
		value !== null &&
		'mediaDevices' in value &&
		typeof value.mediaDevices === 'object' &&
		value.mediaDevices !== null &&
		'getUserMedia' in value.mediaDevices &&
		typeof value.mediaDevices.getUserMedia === 'function' &&
		'registerGlobals' in value &&
		typeof value.registerGlobals === 'function'
	);
};

const hasDefaultExport = (value: unknown): value is { default: unknown } => {
	return typeof value === 'object' && value !== null && 'default' in value;
};

const ensureWebRTCModule = async (): Promise<TWebRTCModule> => {
	if (!cachedWebRTCModulePromise) {
		cachedWebRTCModulePromise = import('react-native-webrtc')
			.then((rawModule: unknown) => {
				const module = isWebRTCModule(rawModule)
					? rawModule
					: hasDefaultExport(rawModule) && isWebRTCModule(rawModule.default)
						? rawModule.default
						: null;

				if (!module) {
					throw new Error('react-native-webrtc did not expose the expected runtime API');
				}

				module.registerGlobals();
				return module;
			})
			.catch((error: unknown) => {
				cachedWebRTCModulePromise = null;
				throw toError(error, 'Failed to load react-native-webrtc');
			});
	}

	return cachedWebRTCModulePromise;
};

function MobileVoiceProvider({ children }: PropsWithChildren) {
	const connected = useServerStore((state) => state.connected);
	const currentVoiceChannelId = useServerStore(currentVoiceChannelIdSelector);
	const ownVoiceState = useServerStore(ownVoiceStateSelector);
	const [connectionStatus, setConnectionStatus] = useState<TConnectionStatus>('disconnected');
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
	const [reconnectRetryToken, setReconnectRetryToken] = useState(0);
	const [isBusy, setIsBusy] = useState(false);
	const [remoteAudioRenderers, setRemoteAudioRenderers] = useState<TRemoteAudioRenderer[]>([]);
	const [RTCViewComponent, setRTCViewComponent] = useState<TRTCViewComponent | null>(null);
	const currentVoiceChannelIdRef = useRef<number | undefined>(currentVoiceChannelId);
	const ownVoiceStateRef = useRef(ownVoiceState);
	const joiningChannelIdRef = useRef<number | undefined>(undefined);
	const reconnectingRef = useRef(false);
	const deviceRef = useRef<Device | undefined>(undefined);
	const rtpCapabilitiesRef = useRef<RtpCapabilities | undefined>(undefined);
	const producerTransportRef = useRef<Transport<AppData> | undefined>(undefined);
	const consumerTransportRef = useRef<Transport<AppData> | undefined>(undefined);
	const audioProducerRef = useRef<Producer<AppData> | undefined>(undefined);
	const localAudioStreamRef = useRef<TWebRTCMediaStream | undefined>(undefined);
	const localAudioTrackRef = useRef<MediaStreamTrack | undefined>(undefined);
	const remoteAudioStreamsRef = useRef<Map<number, TWebRTCMediaStream>>(new Map());
	const remoteAudioConsumersRef = useRef<Map<number, Consumer<AppData>>>(new Map());
	const consumeOperationsRef = useRef<Set<number>>(new Set());
	const subscriptionsRef = useRef<TVoiceSubscriptions>({});

	useEffect(() => {
		currentVoiceChannelIdRef.current = currentVoiceChannelId;
	}, [currentVoiceChannelId]);

	useEffect(() => {
		ownVoiceStateRef.current = ownVoiceState;
	}, [ownVoiceState]);

	const unsubscribeVoiceEvents = useCallback(() => {
		subscriptionsRef.current.onNewProducer?.unsubscribe();
		subscriptionsRef.current.onProducerClosed?.unsubscribe();
		subscriptionsRef.current.onUserLeave?.unsubscribe();
		subscriptionsRef.current = {};
	}, []);

	const closeRemoteAudioConsumer = useCallback((remoteUserId: number) => {
		const consumer = remoteAudioConsumersRef.current.get(remoteUserId);

		if (!consumer) {
			remoteAudioStreamsRef.current.delete(remoteUserId);
			setRemoteAudioRenderers((currentEntries) =>
				currentEntries.filter((entry) => entry.remoteUserId !== remoteUserId),
			);
			return;
		}

		if (!consumer.closed) {
			consumer.close();
		}

		remoteAudioConsumersRef.current.delete(remoteUserId);
		remoteAudioStreamsRef.current.delete(remoteUserId);
		setRemoteAudioRenderers((currentEntries) => currentEntries.filter((entry) => entry.remoteUserId !== remoteUserId));
	}, []);

	const applySoundMutedToConsumers = useCallback((muted: boolean) => {
		remoteAudioConsumersRef.current.forEach((consumer) => {
			if (consumer.closed) {
				return;
			}

			if (muted) {
				consumer.pause();
				consumer.track.enabled = false;
				return;
			}

			consumer.track.enabled = true;
			consumer.resume();
		});
	}, []);

	const cleanupVoiceSession = useCallback(() => {
		unsubscribeVoiceEvents();
		consumeOperationsRef.current.clear();

		remoteAudioConsumersRef.current.forEach((consumer) => {
			if (!consumer.closed) {
				consumer.close();
			}
		});
		remoteAudioConsumersRef.current.clear();
		remoteAudioStreamsRef.current.clear();
		setRemoteAudioRenderers([]);

		if (audioProducerRef.current && !audioProducerRef.current.closed) {
			audioProducerRef.current.close();
		}
		audioProducerRef.current = undefined;

		if (localAudioTrackRef.current) {
			localAudioTrackRef.current.stop();
		}
		localAudioTrackRef.current = undefined;

		localAudioStreamRef.current?.getTracks().forEach((track: MediaStreamTrack) => {
			track.stop();
		});
		localAudioStreamRef.current = undefined;

		if (producerTransportRef.current && !producerTransportRef.current.closed) {
			producerTransportRef.current.close();
		}
		producerTransportRef.current = undefined;

		if (consumerTransportRef.current && !consumerTransportRef.current.closed) {
			consumerTransportRef.current.close();
		}
		consumerTransportRef.current = undefined;

		deviceRef.current = undefined;
		rtpCapabilitiesRef.current = undefined;
	}, [unsubscribeVoiceEvents]);

	const setCurrentVoiceChannelId = useCallback((channelId: number | undefined) => {
		useServerStore.getState().setCurrentVoiceChannelId(channelId);
	}, []);

	const updateOwnVoiceState = useCallback((nextState: Partial<typeof ownVoiceState>) => {
		useServerStore.getState().updateOwnVoiceState(nextState);
	}, []);

	const consumeAudio = useCallback(
		async ({ remoteUserId, rtpCapabilities }: TConsumeAudioOptions) => {
			if (!consumerTransportRef.current) {
				return;
			}

			if (consumeOperationsRef.current.has(remoteUserId)) {
				return;
			}

			consumeOperationsRef.current.add(remoteUserId);

			try {
				const trpc = getTRPCClient();
				const webRTCModule = await ensureWebRTCModule();
				const { consumerId, consumerRtpParameters, producerId } = await trpc.voice.consume.mutate({
					kind: StreamKind.AUDIO,
					remoteId: remoteUserId,
					rtpCapabilities,
				});

				closeRemoteAudioConsumer(remoteUserId);

				const consumer = await consumerTransportRef.current.consume({
					id: consumerId,
					kind: 'audio',
					producerId,
					rtpParameters: consumerRtpParameters,
				});

				if (ownVoiceStateRef.current.soundMuted) {
					consumer.pause();
					consumer.track.enabled = false;
				}

				remoteAudioConsumersRef.current.set(remoteUserId, consumer);
				const stream = new webRTCModule.MediaStream([consumer.track]);
				remoteAudioStreamsRef.current.set(remoteUserId, stream);
				setRemoteAudioRenderers((currentEntries) => {
					const nextEntries = currentEntries.filter((entry) => entry.remoteUserId !== remoteUserId);
					nextEntries.push({
						remoteUserId,
						streamURL: stream.toURL(),
					});
					return nextEntries;
				});
			} finally {
				consumeOperationsRef.current.delete(remoteUserId);
			}
		},
		[closeRemoteAudioConsumer],
	);

	const ensureMicrophoneProducer = useCallback(async () => {
		if (audioProducerRef.current && !audioProducerRef.current.closed) {
			return;
		}

		const producerTransport = producerTransportRef.current;

		if (!producerTransport) {
			return;
		}

		const { mediaDevices, permissions } = await ensureWebRTCModule();
		const permissionResult = await permissions.request({ name: 'microphone' });
		const microphoneGranted = permissionResult === true || permissionResult === permissions.RESULT.GRANTED;

		if (!microphoneGranted) {
			throw new Error('Microphone permission was denied.');
		}

		const stream = await mediaDevices.getUserMedia({
			audio: true,
			video: false,
		});
		const [audioTrack] = stream.getAudioTracks();

		if (!audioTrack) {
			stream.getTracks().forEach((track: MediaStreamTrack) => {
				track.stop();
			});
			throw new Error('Microphone stream did not include an audio track');
		}

		audioTrack.enabled = !ownVoiceStateRef.current.micMuted;

		const producer = await producerTransport.produce({
			appData: { kind: StreamKind.AUDIO },
			codecOptions: AUDIO_OPUS_CODEC_OPTIONS,
			track: audioTrack,
		});

		localAudioStreamRef.current = stream;
		localAudioTrackRef.current = audioTrack;
		audioProducerRef.current = producer;
	}, []);

	const createProducerTransport = useCallback(async (device: Device, params?: TTransportParams) => {
		const trpc = getTRPCClient();
		const transportParams = params ?? (await trpc.voice.createProducerTransport.mutate());
		const transport = device.createSendTransport(transportParams);

		transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
			try {
				await trpc.voice.connectProducerTransport.mutate({ dtlsParameters });
				callback();
			} catch (error) {
				errback(toError(error, 'Failed to connect producer transport'));
			}
		});

		transport.on('produce', async ({ appData, rtpParameters }, callback, errback) => {
			const streamKind = appData.kind;

			if (streamKind !== StreamKind.AUDIO) {
				errback(new Error('Unsupported mobile stream kind'));
				return;
			}

			try {
				const producerId = await trpc.voice.produce.mutate({
					kind: streamKind,
					rtpParameters,
					transportId: transport.id,
				});

				callback({ id: producerId });
			} catch (error) {
				errback(toError(error, 'Failed to produce audio track'));
			}
		});

		producerTransportRef.current = transport;
	}, []);

	const createConsumerTransport = useCallback(async (device: Device, params?: TTransportParams) => {
		const trpc = getTRPCClient();
		const transportParams = params ?? (await trpc.voice.createConsumerTransport.mutate());
		const transport = device.createRecvTransport(transportParams);

		transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
			try {
				await trpc.voice.connectConsumerTransport.mutate({ dtlsParameters });
				callback();
			} catch (error) {
				errback(toError(error, 'Failed to connect consumer transport'));
			}
		});

		consumerTransportRef.current = transport;
	}, []);

	const subscribeToVoiceEvents = useCallback(
		(channelId: number, rtpCapabilities: RtpCapabilities) => {
			unsubscribeVoiceEvents();

			const trpc = getTRPCClient();

			subscriptionsRef.current.onNewProducer = trpc.voice.onNewProducer.subscribe(undefined, {
				onData: ({ channelId: nextChannelId, kind, remoteId }) => {
					if (nextChannelId !== channelId || remoteId === useServerStore.getState().ownUserId) {
						return;
					}

					if (kind === StreamKind.AUDIO) {
						void consumeAudio({
							remoteUserId: remoteId,
							rtpCapabilities,
						});
					}
				},
				onError: () => {},
			});

			subscriptionsRef.current.onProducerClosed = trpc.voice.onProducerClosed.subscribe(undefined, {
				onData: ({ channelId: nextChannelId, kind, remoteId }) => {
					if (nextChannelId !== channelId || kind !== StreamKind.AUDIO) {
						return;
					}

					closeRemoteAudioConsumer(remoteId);
				},
				onError: () => {},
			});

			subscriptionsRef.current.onUserLeave = trpc.voice.onLeave.subscribe(undefined, {
				onData: ({ channelId: nextChannelId, userId }) => {
					if (nextChannelId !== channelId) {
						return;
					}

					closeRemoteAudioConsumer(userId);
				},
				onError: () => {},
			});
		},
		[closeRemoteAudioConsumer, consumeAudio, unsubscribeVoiceEvents],
	);

	const initializeVoiceSession = useCallback(
		async (
			channelId: number,
			routerRtpCapabilities: RtpCapabilities,
			params: {
				producerTransportParams?: TTransportParams;
				consumerTransportParams?: TTransportParams;
				existingProducers?: TRemoteProducerIds;
			},
		) => {
			const webRTCModule = await ensureWebRTCModule();
			setRTCViewComponent(() => webRTCModule.RTCView);
			cleanupVoiceSession();

			const device = new Device();
			await device.load({ routerRtpCapabilities });

			deviceRef.current = device;
			rtpCapabilitiesRef.current = device.rtpCapabilities;

			await Promise.all([
				createProducerTransport(device, params.producerTransportParams),
				createConsumerTransport(device, params.consumerTransportParams),
			]);

			subscribeToVoiceEvents(channelId, device.rtpCapabilities);

			await Promise.all(
				(params.existingProducers?.remoteAudioIds ?? []).map((remoteUserId) =>
					consumeAudio({
						remoteUserId,
						rtpCapabilities: device.rtpCapabilities,
					}),
				),
			);

			try {
				await ensureMicrophoneProducer();
			} catch (error) {
				updateOwnVoiceState({ micMuted: true });
				setErrorMessage(getErrorMessage(error, 'Joined voice, but microphone access failed.'));
				void getTRPCClient()
					.voice.updateState.mutate({ micMuted: true })
					.catch(() => {});
			}

			applySoundMutedToConsumers(ownVoiceStateRef.current.soundMuted);
		},
		[
			applySoundMutedToConsumers,
			cleanupVoiceSession,
			consumeAudio,
			createConsumerTransport,
			createProducerTransport,
			ensureMicrophoneProducer,
			subscribeToVoiceEvents,
			updateOwnVoiceState,
		],
	);

	const leaveChannel = useCallback(
		async (options?: TLeaveChannelOptions) => {
			const notifyServer = options?.notifyServer ?? true;
			const clearPendingReconnect = options?.clearPendingReconnect ?? true;
			const activeChannelId = currentVoiceChannelIdRef.current;

			if (clearPendingReconnect) {
				clearPendingVoiceReconnectChannelId();
			}

			setIsBusy(true);
			setErrorMessage(undefined);
			setConnectionStatus('disconnected');
			setCurrentVoiceChannelId(undefined);
			cleanupVoiceSession();

			try {
				if (notifyServer && activeChannelId !== undefined && connected) {
					await getTRPCClient().voice.leave.mutate();
				}
			} catch {
				// best effort
			} finally {
				setIsBusy(false);
			}
		},
		[cleanupVoiceSession, connected, setCurrentVoiceChannelId],
	);

	const joinChannel = useCallback(
		async (channelId: number, options?: TJoinChannelOptions): Promise<TJoinResult> => {
			if (!channelId || Number.isNaN(channelId)) {
				return 'non-retriable-failure';
			}

			if (
				channelId === currentVoiceChannelIdRef.current &&
				(connectionStatus === 'connected' || connectionStatus === 'connecting' || connectionStatus === 'reconnecting')
			) {
				return 'already-joined';
			}

			if (joiningChannelIdRef.current === channelId) {
				return 'already-joined';
			}

			joiningChannelIdRef.current = channelId;
			setIsBusy(true);
			setErrorMessage(undefined);
			setConnectionStatus(options?.playJoinSound === false ? 'reconnecting' : 'connecting');

			let serverJoinSucceeded = false;

			try {
				const existingChannelId = currentVoiceChannelIdRef.current;

				if (existingChannelId !== undefined && existingChannelId !== channelId) {
					await leaveChannel({
						clearPendingReconnect: false,
						notifyServer: true,
					});
				}

				const { micMuted, soundMuted } = ownVoiceStateRef.current;
				const joinResult = await getTRPCClient().voice.join.mutate({
					channelId,
					state: {
						micMuted,
						soundMuted,
					},
				});
				serverJoinSucceeded = true;
				setCurrentVoiceChannelId(channelId);

				await initializeVoiceSession(channelId, joinResult.routerRtpCapabilities, {
					consumerTransportParams: joinResult.consumerTransportParams,
					existingProducers: joinResult.existingProducers,
					producerTransportParams: joinResult.producerTransportParams,
				});

				clearPendingVoiceReconnectChannelId();
				setConnectionStatus('connected');
				return 'joined';
			} catch (error) {
				cleanupVoiceSession();
				setCurrentVoiceChannelId(undefined);
				setConnectionStatus('failed');
				setErrorMessage(getErrorMessage(error, 'Failed to join voice channel.'));

				if (serverJoinSucceeded) {
					void getTRPCClient()
						.voice.leave.mutate()
						.catch(() => {});
				}

				return isNonRetriableJoinError(error) ? 'non-retriable-failure' : 'retryable-failure';
			} finally {
				joiningChannelIdRef.current = undefined;
				setIsBusy(false);
			}
		},
		[cleanupVoiceSession, connectionStatus, initializeVoiceSession, leaveChannel, setCurrentVoiceChannelId],
	);

	const setMicMuted = useCallback(
		async (muted: boolean) => {
			updateOwnVoiceState({ micMuted: muted });
			setErrorMessage(undefined);

			try {
				if (!muted) {
					await ensureMicrophoneProducer();
				}

				if (localAudioTrackRef.current) {
					localAudioTrackRef.current.enabled = !muted;
				}

				await getTRPCClient().voice.updateState.mutate({ micMuted: muted });
			} catch (error) {
				updateOwnVoiceState({ micMuted: !muted });
				setErrorMessage(getErrorMessage(error, 'Failed to update microphone state.'));
			}
		},
		[ensureMicrophoneProducer, updateOwnVoiceState],
	);

	const setSoundMuted = useCallback(
		async (muted: boolean) => {
			updateOwnVoiceState({ soundMuted: muted });
			applySoundMutedToConsumers(muted);
			setErrorMessage(undefined);

			try {
				await getTRPCClient().voice.updateState.mutate({ soundMuted: muted });
			} catch (error) {
				updateOwnVoiceState({ soundMuted: !muted });
				applySoundMutedToConsumers(!muted);
				setErrorMessage(getErrorMessage(error, 'Failed to update speaker state.'));
			}
		},
		[applySoundMutedToConsumers, updateOwnVoiceState],
	);

	useEffect(() => {
		if (!connected) {
			cleanupVoiceSession();
			setConnectionStatus('disconnected');
			return;
		}

		if (localAudioTrackRef.current) {
			localAudioTrackRef.current.enabled = !ownVoiceState.micMuted;
		}

		applySoundMutedToConsumers(ownVoiceState.soundMuted);
	}, [applySoundMutedToConsumers, cleanupVoiceSession, connected, ownVoiceState.micMuted, ownVoiceState.soundMuted]);

	useEffect(() => {
		if (!connected || currentVoiceChannelId !== undefined || reconnectingRef.current) {
			return;
		}

		void reconnectRetryToken;

		const pendingChannelId = getPendingVoiceReconnectChannelId();

		if (pendingChannelId === undefined) {
			return;
		}

		reconnectingRef.current = true;
		let cancelled = false;
		let retryTimeoutId: ReturnType<typeof setTimeout> | undefined;

		const scheduleRetry = () => {
			if (cancelled) {
				return;
			}

			if (getPendingVoiceReconnectRetryCount() < MAX_VOICE_REJOIN_RETRIES) {
				incrementPendingVoiceReconnectRetryCount();
				retryTimeoutId = setTimeout(() => {
					setReconnectRetryToken((value) => value + 1);
				}, VOICE_REJOIN_RETRY_DELAY_MS);
				return;
			}

			clearPendingVoiceReconnectChannelId();
			setConnectionStatus('failed');
			setErrorMessage('Failed to restore the voice connection after multiple attempts.');
		};

		void (async () => {
			try {
				const result = await joinChannel(pendingChannelId, {
					playJoinSound: false,
				});

				if (result === 'retryable-failure') {
					scheduleRetry();
					return;
				}

				if (result === 'non-retriable-failure') {
					clearPendingVoiceReconnectChannelId();
				}
			} finally {
				reconnectingRef.current = false;
			}
		})();

		return () => {
			cancelled = true;

			if (retryTimeoutId) {
				clearTimeout(retryTimeoutId);
			}
		};
	}, [connected, currentVoiceChannelId, joinChannel, reconnectRetryToken]);

	useEffect(() => {
		return () => {
			cleanupVoiceSession();
		};
	}, [cleanupVoiceSession]);

	const value = useMemo<TMobileVoiceContextValue>(
		() => ({
			connectionStatus,
			errorMessage,
			isBusy,
			joinChannel,
			leaveChannel: async () => {
				await leaveChannel({
					clearPendingReconnect: true,
					notifyServer: true,
				});
			},
			setMicMuted,
			setSoundMuted,
		}),
		[connectionStatus, errorMessage, isBusy, joinChannel, leaveChannel, setMicMuted, setSoundMuted],
	);

	return (
		<MobileVoiceContext.Provider value={value}>
			{children}
			{RTCViewComponent ? (
				<View pointerEvents="none" style={styles.hiddenAudioRenderContainer}>
					{remoteAudioRenderers.map(({ remoteUserId, streamURL }) => (
						<RTCViewComponent
							key={String(remoteUserId)}
							mirror={false}
							objectFit="cover"
							streamURL={streamURL}
							style={styles.hiddenAudioRenderer}
							zOrder={0}
						/>
					))}
				</View>
			) : null}
		</MobileVoiceContext.Provider>
	);
}

const useMobileVoice = (): TMobileVoiceContextValue => {
	const context = useContext(MobileVoiceContext);

	if (!context) {
		throw new Error('useMobileVoice must be used within MobileVoiceProvider');
	}

	return context;
};

const styles = StyleSheet.create({
	hiddenAudioRenderContainer: {
		height: 1,
		left: 0,
		opacity: 0,
		position: 'absolute',
		top: 0,
		width: 1,
	},
	hiddenAudioRenderer: {
		height: 1,
		width: 1,
	},
});

export { MobileVoiceProvider, useMobileVoice };
