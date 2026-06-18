import {
	ServerEvents,
	StreamKind,
	type TChannelState,
	type TExternalStreamsMap,
	type TRemoteProducerIds,
	type TTransportParams,
	type TVoiceMap,
	type TVoiceUserState,
} from '@sharkord/shared';
import type {
	AppData,
	AudioLevelObserver,
	AudioLevelObserverVolume,
	Consumer,
	Producer,
	Router,
	RouterOptions,
	WebRtcTransport,
} from 'mediasoup/types';
import { logger } from '../logger';
import { eventBus } from '../plugins/event-bus';
import { invariant } from '../utils/invariant';
import { mediaSoupWorker, webRtcServer, webRtcServerListenInfo, webRtcServerListenInfos } from '../utils/mediasoup';
import { pubsub } from '../utils/pubsub';
import {
	evaluateMediaLiveness,
	MEDIA_LIVENESS_CHECK_INTERVAL_MS,
	MEDIA_LIVENESS_JITTER_MS,
	MEDIA_LIVENESS_TIMEOUT_MS,
	type TMediaLivenessState,
} from './media-liveness';
import { recordMediaLivenessFailure } from './media-liveness-telemetry';

const voiceRuntimes = new Map<number, VoiceRuntime>();
// initialAvailableOutgoingBitrate seeds the transport's send-side bandwidth
// estimate, so it only has an effect where the server sends media — consumer
// transports. On producer transports (server receives) it is inert; the value
// is kept for clarity.
const PRODUCER_INITIAL_AVAILABLE_OUTGOING_BITRATE_BPS = 6_000_000;
// Seed the SFU→viewer estimate high enough that a screen share is watchable
// immediately instead of ramping from 6 Mbps: 10 Mbps covers the start bitrate
// of every screen tier up to 1080p60/1440p30, and GCC's ~8%/s growth closes
// the gap to the higher tiers in a few seconds instead of ~10s. A viewer on a
// weaker downlink eats a short burst before the first transport-CC feedback
// clamps the estimate — the same self-correcting risk the previous 6 Mbps
// value carried, slightly larger.
const CONSUMER_INITIAL_AVAILABLE_OUTGOING_BITRATE_BPS = 10_000_000;
const VOICE_ACTIVITY_OBSERVER_MAX_ENTRIES = 100;
const VOICE_ACTIVITY_OBSERVER_THRESHOLD_DBOV = -60;
const VOICE_ACTIVITY_OBSERVER_INTERVAL_MS = 100;
const VOICE_ACTIVITY_RELEASE_DELAY_MS = 350;

const defaultRouterOptions: RouterOptions<AppData> = {
	mediaCodecs: [
		{
			kind: 'video',
			mimeType: 'video/VP8',
			clockRate: 90000,
			parameters: {
				'x-google-start-bitrate': 2500,
			},
		},
		{
			kind: 'video',
			mimeType: 'video/VP9',
			clockRate: 90000,
			parameters: {
				'profile-id': 0,
				'x-google-start-bitrate': 2500,
			},
		},
		// H264 is offered twice: High profile first (preferred) and Constrained
		// Baseline second (fallback). High profile (CABAC + 8x8 transform) is far
		// more efficient per bit than Baseline, which directly reduces the chroma
		// bleed / edge artifacts on detailed screen shares; it is universally
		// decodable and supported by modern hardware encoders. Clients that only
		// negotiate Baseline still match the second entry instead of dropping to
		// VP8. level-asymmetry-allowed lets encoder/decoder pick independent levels.
		{
			kind: 'video',
			mimeType: 'video/H264',
			clockRate: 90000,
			parameters: {
				'packetization-mode': 1,
				'profile-level-id': '640034',
				'level-asymmetry-allowed': 1,
				'x-google-start-bitrate': 2500,
			},
		},
		{
			kind: 'video',
			mimeType: 'video/H264',
			clockRate: 90000,
			parameters: {
				'packetization-mode': 1,
				'profile-level-id': '42e02a',
				'level-asymmetry-allowed': 1,
				'x-google-start-bitrate': 2500,
			},
		},
		{
			kind: 'audio',
			mimeType: 'audio/opus',
			clockRate: 48000,
			channels: 2,
			parameters: {
				useinbandfec: 1,
				usedtx: 1,
			},
		},
	],
};

const defaultUserState: TVoiceUserState = {
	micMuted: false,
	soundMuted: false,
	webcamEnabled: false,
	sharingScreen: false,
};

type TTransportMap = {
	[userId: number]: WebRtcTransport<AppData>;
};

type TProducerMap = {
	[userId: number]: Producer<AppData>;
};

type TConsumerMap = {
	[userId: number]: {
		[remoteId: number]: Partial<Record<StreamKind, Consumer<AppData>>>;
	};
};

type TExternalStreamProducers = {
	audioProducer?: Producer<AppData>;
	videoProducer?: Producer<AppData>;
};

type TExternalStreamInternal = {
	title: string;
	key: string;
	pluginId: string;
	avatarUrl?: string;
	producers: TExternalStreamProducers;
};

class VoiceRuntime {
	public readonly id: number;
	private state: TChannelState = { users: [], externalStreams: {} };
	private router?: Router<AppData>;
	private consumerTransports: TTransportMap = {};
	private producerTransports: TTransportMap = {};
	private videoProducers: TProducerMap = {};
	private audioProducers: TProducerMap = {};
	private screenProducers: TProducerMap = {};
	private screenAudioProducers: TProducerMap = {};
	private consumers: TConsumerMap = {};
	private audioLevelObserver?: AudioLevelObserver<AppData>;
	private voiceActivityProducerIdsByUser = new Map<number, string>();
	private voiceActivityUserIdsByProducer = new Map<string, number>();
	private speakingUserIds = new Set<number>();
	private voiceActivityReleaseTimers = new Map<number, ReturnType<typeof setTimeout>>();
	private mediaLiveness = new Map<number, TMediaLivenessState>();
	private mediaLivenessTimer?: ReturnType<typeof setInterval>;
	private mediaLivenessCheckInFlight = false;

	private externalCounter = 0;
	private externalStreamsInternal: {
		[streamId: number]: TExternalStreamInternal;
	} = {};

	constructor(channelId: number) {
		this.id = channelId;
		voiceRuntimes.set(channelId, this);
	}

	public static findById = (channelId: number): VoiceRuntime | undefined => {
		return voiceRuntimes.get(channelId);
	};

	public static findRuntimeByUserId = (userId: number): VoiceRuntime | undefined => {
		for (const runtime of voiceRuntimes.values()) {
			if (runtime.getUser(userId)) {
				return runtime;
			}
		}

		return undefined;
	};

	public static getAll = (): VoiceRuntime[] => {
		return Array.from(voiceRuntimes.values());
	};

	public static requireJoinedRuntime = (channelId: number | undefined, userId: number): VoiceRuntime => {
		invariant(channelId, {
			code: 'BAD_REQUEST',
			message: 'User is not in a voice channel',
		});

		const runtime = VoiceRuntime.findById(channelId);

		invariant(runtime, {
			code: 'INTERNAL_SERVER_ERROR',
			message: 'Voice runtime not found for this channel',
		});

		invariant(runtime.getUser(userId), {
			code: 'BAD_REQUEST',
			message: 'User is not in a voice channel',
		});

		return runtime;
	};

	public static getVoiceMap = (): TVoiceMap => {
		const map: TVoiceMap = {};

		voiceRuntimes.forEach((runtime, channelId) => {
			map[channelId] = {
				users: {},
			};

			runtime.getState().users.forEach((user) => {
				if (!map[channelId]) {
					map[channelId] = { users: {} };
				}

				map[channelId].users[user.userId] = user.state;
			});
		});

		return map;
	};

	public static getExternalStreamsMap = (): TExternalStreamsMap => {
		const map: TExternalStreamsMap = {};

		voiceRuntimes.forEach((runtime, channelId) => {
			if (map[channelId]) {
				map[channelId] = [];
			}

			map[channelId] = runtime.getState().externalStreams;
		});

		return map;
	};

	public init = async (): Promise<void> => {
		logger.debug(`Initializing voice runtime for channel ${this.id}`);

		await this.createRouter();

		this.startMediaLivenessMonitor();

		eventBus.emit('voice:runtime_initialized', {
			channelId: this.id,
		});
	};

	public destroy = async () => {
		this.stopMediaLivenessMonitor();
		this.clearAllVoiceActivity();

		// Closing the router automatically closes all transports, producers, and
		// consumers attached to it — no need to close them individually.
		// Assumes all users have already been removed (via removeUser) before this
		// is called; any remaining open producers will emit VOICE_PRODUCER_CLOSED
		// as a side effect of the cascade.
		await this.router?.close();

		voiceRuntimes.delete(this.id);

		eventBus.emit('voice:runtime_closed', {
			channelId: this.id,
		});
	};

	public getState = (): TChannelState => {
		return this.state;
	};

	public getUser = (userId: number) => {
		return this.state.users.find((u) => u.userId === userId);
	};

	public getUserState = (userId: number): TVoiceUserState => {
		const user = this.getUser(userId);

		return user?.state ?? defaultUserState;
	};

	public addUser = (userId: number, state: Pick<TVoiceUserState, 'micMuted' | 'soundMuted'>) => {
		if (this.getUser(userId)) return;

		this.state.users.push({
			userId,
			state: {
				...defaultUserState,
				...state,
			},
		});
	};

	public removeUser = (userId: number) => {
		this.state.users = this.state.users.filter((u) => u.userId !== userId);

		this.cleanupUserResources(userId);
		this.setUserSpeaking(userId, false);
	};

	private cleanupUserResources = (userId: number) => {
		this.mediaLiveness.delete(userId);

		this.removeProducerTransport(userId);
		this.removeConsumerTransport(userId);

		this.removeProducer(userId, StreamKind.AUDIO);
		this.removeProducer(userId, StreamKind.VIDEO);
		this.removeProducer(userId, StreamKind.SCREEN);
		this.removeProducer(userId, StreamKind.SCREEN_AUDIO);

		if (this.consumers[userId]) {
			Object.values(this.consumers[userId]).forEach((remoteConsumers) => {
				Object.values(remoteConsumers).forEach((consumer) => {
					consumer?.close();
				});
			});

			delete this.consumers[userId];
		}

		Object.keys(this.consumers).forEach((consumerUserIdStr) => {
			const consumerId = parseInt(consumerUserIdStr, 10);

			if (consumerId === userId) {
				return;
			}

			const consumerGroups = this.consumers[consumerId];
			const remoteConsumers = consumerGroups?.[userId];

			if (!consumerGroups || !remoteConsumers) {
				return;
			}

			Object.values(remoteConsumers).forEach((consumer) => {
				consumer?.close();
			});

			if (consumerGroups[userId]) {
				delete consumerGroups[userId];
			}

			if (this.consumers[consumerId] === consumerGroups && Object.keys(consumerGroups).length === 0) {
				delete this.consumers[consumerId];
			}
		});
	};

	public updateUserState = (userId: number, newState: Partial<TChannelState['users'][0]['state']>) => {
		const user = this.getUser(userId);

		if (!user) return;

		user.state = { ...user.state, ...newState };

		if (newState.micMuted === true) {
			this.setUserSpeaking(userId, false);
		}
	};

	private resetStreamUserStateOnProducerClose = (userId: number, flag: 'sharingScreen' | 'webcamEnabled') => {
		const user = this.getUser(userId);

		if (!user || user.state[flag] === false) {
			return;
		}

		this.updateUserState(userId, flag === 'sharingScreen' ? { sharingScreen: false } : { webcamEnabled: false });

		pubsub.publish(ServerEvents.USER_VOICE_STATE_UPDATE, {
			channelId: this.id,
			userId,
			state: this.getUserState(userId),
		});
	};

	public getRouter = (): Router<AppData> => {
		if (!this.router) {
			throw new Error('Router not initialized yet');
		}

		return this.router;
	};

	private createRouter = async () => {
		const router = await mediaSoupWorker.createRouter(defaultRouterOptions);

		this.router = router;

		try {
			this.audioLevelObserver = await router.createAudioLevelObserver({
				maxEntries: VOICE_ACTIVITY_OBSERVER_MAX_ENTRIES,
				threshold: VOICE_ACTIVITY_OBSERVER_THRESHOLD_DBOV,
				interval: VOICE_ACTIVITY_OBSERVER_INTERVAL_MS,
			});

			this.audioLevelObserver.on('volumes', this.handleVoiceActivityVolumes);
			this.audioLevelObserver.on('silence', this.handleVoiceActivitySilence);
			this.audioLevelObserver.on('routerclose', () => {
				this.audioLevelObserver = undefined;
				this.clearAllVoiceActivity();
			});
		} catch (error) {
			logger.error('Failed to create voice activity observer:', error);
		}
	};

	public createTransport = async (initialAvailableOutgoingBitrate: number) => {
		const router = this.getRouter();

		const transport = await router.createWebRtcTransport({
			webRtcServer,
			enableUdp: true,
			enableTcp: true,
			preferUdp: true,
			preferTcp: false,
			initialAvailableOutgoingBitrate,
		});

		const params: TTransportParams = {
			id: transport.id,
			iceParameters: transport.iceParameters,
			iceCandidates: transport.iceCandidates,
			dtlsParameters: transport.dtlsParameters,
		};

		return { transport, params };
	};

	public createConsumerTransport = async (userId: number) => {
		this.removeConsumerTransport(userId);

		const { transport, params } = await this.createTransport(CONSUMER_INITIAL_AVAILABLE_OUTGOING_BITRATE_BPS);

		this.consumerTransports[userId] = transport;

		transport.observer.on('close', () => {
			delete this.consumerTransports[userId];

			if (this.consumers[userId]) {
				Object.values(this.consumers[userId]).forEach((remoteConsumers) => {
					Object.values(remoteConsumers).forEach((consumer) => {
						consumer?.close();
					});
				});

				delete this.consumers[userId];
			}
		});

		transport.on('dtlsstatechange', (state) => {
			if (state === 'failed') {
				this.removeConsumerTransport(userId);
				pubsub.publishFor(userId, ServerEvents.VOICE_TRANSPORT_FAILED, {
					userId,
				});
			}
		});

		return params;
	};

	public removeConsumerTransport = (userId: number) => {
		const transport = this.consumerTransports[userId];

		if (!transport) return;

		transport.close();
	};

	public getConsumerTransport = (userId: number) => {
		return this.consumerTransports[userId];
	};

	public createProducerTransport = async (userId: number) => {
		this.removeProducerTransport(userId);

		const { params, transport } = await this.createTransport(PRODUCER_INITIAL_AVAILABLE_OUTGOING_BITRATE_BPS);

		this.producerTransports[userId] = transport;

		transport.observer.on('close', () => {
			delete this.producerTransports[userId];

			this.removeProducer(userId, StreamKind.AUDIO);
			this.removeProducer(userId, StreamKind.VIDEO);
			this.removeProducer(userId, StreamKind.SCREEN);
			this.removeProducer(userId, StreamKind.SCREEN_AUDIO);
		});

		transport.on('dtlsstatechange', (state) => {
			if (state === 'failed') {
				this.removeProducerTransport(userId);
				pubsub.publishFor(userId, ServerEvents.VOICE_TRANSPORT_FAILED, {
					userId,
				});
			}
		});

		return params;
	};

	public removeProducerTransport = (userId: number) => {
		const transport = this.producerTransports[userId];

		if (!transport) return;

		transport.close();
	};

	public getProducerTransport = (userId: number) => {
		return this.producerTransports[userId];
	};

	public getProducer = (type: StreamKind, id: number) => {
		switch (type) {
			case StreamKind.VIDEO:
			case StreamKind.AUDIO:
			case StreamKind.SCREEN:
			case StreamKind.SCREEN_AUDIO:
				return this.getUserProducerByKind(id, type);
			case StreamKind.EXTERNAL_VIDEO:
				return this.externalStreamsInternal[id]?.producers.videoProducer;
			case StreamKind.EXTERNAL_AUDIO:
				return this.externalStreamsInternal[id]?.producers.audioProducer;
			default:
				return undefined;
		}
	};

	private getUserProducerByKind = (userId: number, type: StreamKind): Producer<AppData> | undefined => {
		switch (type) {
			case StreamKind.VIDEO:
				return this.videoProducers[userId];
			case StreamKind.AUDIO:
				return this.audioProducers[userId];
			case StreamKind.SCREEN:
				return this.screenProducers[userId];
			case StreamKind.SCREEN_AUDIO:
				return this.screenAudioProducers[userId];
			default:
				return undefined;
		}
	};

	public addProducer = (userId: number, type: StreamKind, producer: Producer<AppData>) => {
		const existingProducer = this.getUserProducerByKind(userId, type);

		if (type === StreamKind.VIDEO) {
			this.videoProducers[userId] = producer;
		} else if (type === StreamKind.AUDIO) {
			this.audioProducers[userId] = producer;
		} else if (type === StreamKind.SCREEN) {
			this.screenProducers[userId] = producer;
		} else if (type === StreamKind.SCREEN_AUDIO) {
			this.screenAudioProducers[userId] = producer;
		}

		if (existingProducer && existingProducer !== producer && !existingProducer.closed) {
			existingProducer.close();
		}

		if (type === StreamKind.AUDIO) {
			this.addAudioProducerToVoiceActivityObserver(userId, producer);
		}

		producer.observer.on('close', () => {
			// A replaced producer can close after its successor was registered.
			// Only the active producer may clear the map entry and broadcast
			// VOICE_PRODUCER_CLOSED — a stale close would otherwise drop a live
			// stream for every viewer.
			if (type === StreamKind.VIDEO) {
				if (this.videoProducers[userId] !== producer) return;
				delete this.videoProducers[userId];
				this.resetStreamUserStateOnProducerClose(userId, 'webcamEnabled');
			} else if (type === StreamKind.AUDIO) {
				if (this.audioProducers[userId] !== producer) return;
				delete this.audioProducers[userId];
				this.removeAudioProducerFromVoiceActivityObserver(userId, producer);
			} else if (type === StreamKind.SCREEN) {
				if (this.screenProducers[userId] !== producer) return;
				delete this.screenProducers[userId];
				this.resetStreamUserStateOnProducerClose(userId, 'sharingScreen');
			} else if (type === StreamKind.SCREEN_AUDIO) {
				if (this.screenAudioProducers[userId] !== producer) return;
				delete this.screenAudioProducers[userId];
			}

			pubsub.publishForChannel(this.id, ServerEvents.VOICE_PRODUCER_CLOSED, {
				channelId: this.id,
				remoteId: userId,
				kind: type,
			});
		});
	};

	public removeProducer(userId: number, type: StreamKind) {
		let producer: Producer<AppData> | undefined;

		switch (type) {
			case StreamKind.VIDEO:
				producer = this.videoProducers[userId];
				break;
			case StreamKind.AUDIO:
				producer = this.audioProducers[userId];
				break;
			case StreamKind.SCREEN:
				producer = this.screenProducers[userId];
				break;
			case StreamKind.SCREEN_AUDIO:
				producer = this.screenAudioProducers[userId];
				break;
			default:
				return;
		}

		if (!producer) return;

		producer.close();
		// Deletion from the map and VOICE_PRODUCER_CLOSED publish are handled
		// by the producer.observer.on('close') registered in addProducer.
	}

	public addConsumer = (userId: number, remoteId: number, kind: StreamKind, consumer: Consumer<AppData>) => {
		if (!this.consumers[userId]) {
			this.consumers[userId] = {};
		}

		if (!this.consumers[userId][remoteId]) {
			this.consumers[userId][remoteId] = {};
		}

		const existingConsumer = this.consumers[userId][remoteId][kind];

		if (existingConsumer && !existingConsumer.closed) {
			existingConsumer.close();
		}

		this.consumers[userId][remoteId][kind] = consumer;

		if (kind === StreamKind.VIDEO || kind === StreamKind.SCREEN) {
			pubsub.publishFor(remoteId, ServerEvents.VOICE_STREAM_WATCHER_ACTIVITY, {
				watcherId: userId,
				kind,
				action: 'joined',
			});
		}

		consumer.observer.on('close', () => {
			const activeConsumer = this.consumers[userId]?.[remoteId]?.[kind];

			if (activeConsumer !== consumer) {
				return;
			}

			if (kind === StreamKind.VIDEO || kind === StreamKind.SCREEN) {
				pubsub.publishFor(remoteId, ServerEvents.VOICE_STREAM_WATCHER_ACTIVITY, {
					watcherId: userId,
					kind,
					action: 'left',
				});
			}

			delete this.consumers[userId]?.[remoteId]?.[kind];

			if (this.consumers[userId]?.[remoteId]) {
				const remoteConsumers = this.consumers[userId][remoteId];

				if (Object.keys(remoteConsumers).length === 0) {
					delete this.consumers[userId][remoteId];
				}
			}

			if (this.consumers[userId] && Object.keys(this.consumers[userId]).length === 0) {
				delete this.consumers[userId];
			}
		});
	};

	public removeConsumer = (userId: number, remoteId: number, kind: StreamKind) => {
		const consumer = this.consumers[userId]?.[remoteId]?.[kind];

		if (!consumer) {
			return;
		}

		consumer.close();
	};

	public resumeConsumer = async (userId: number, remoteId: number, kind: StreamKind) => {
		const consumer = this.consumers[userId]?.[remoteId]?.[kind];

		if (!consumer || consumer.closed) {
			return;
		}

		await consumer.resume();
	};

	public createExternalStream = (options: {
		title: string;
		key: string;
		pluginId: string;
		avatarUrl?: string;
		producers: {
			audio?: Producer;
			video?: Producer;
		};
	}) => {
		const streamId = this.externalCounter++;

		const { title, key, pluginId, avatarUrl, producers } = options;

		this.externalStreamsInternal[streamId] = {
			title,
			key,
			pluginId,
			avatarUrl,
			producers: {
				audioProducer: producers.audio,
				videoProducer: producers.video,
			},
		};

		if (producers.audio) {
			this.setupExternalProducerCloseHandler(streamId, 'audio', producers.audio);
		}

		if (producers.video) {
			this.setupExternalProducerCloseHandler(streamId, 'video', producers.video);
		}

		this.state.externalStreams[streamId] = {
			title,
			key,
			pluginId,
			avatarUrl,
			tracks: {
				audio: !!producers.audio,
				video: !!producers.video,
			},
		};

		return streamId;
	};

	private setupExternalProducerCloseHandler = (streamId: number, kind: 'audio' | 'video', producer: Producer) => {
		producer.observer.on('close', () => {
			const internal = this.externalStreamsInternal[streamId];

			if (!internal) return;

			if (kind === 'audio') {
				if (internal.producers.audioProducer !== producer) {
					return;
				}

				delete internal.producers.audioProducer;
			} else {
				if (internal.producers.videoProducer !== producer) {
					return;
				}

				delete internal.producers.videoProducer;
			}

			const hasProducers = internal.producers.audioProducer || internal.producers.videoProducer;

			if (!hasProducers) {
				this.removeExternalStream(streamId);
			} else {
				const existingStream = this.state.externalStreams[streamId];

				if (existingStream) {
					existingStream.tracks = {
						audio: !!internal.producers.audioProducer,
						video: !!internal.producers.videoProducer,
					};

					pubsub.publish(ServerEvents.VOICE_UPDATE_EXTERNAL_STREAM, {
						channelId: this.id,
						streamId,
						stream: existingStream,
					});
				}
			}
		});
	};

	public removeExternalStream = (streamId: number) => {
		const internal = this.externalStreamsInternal[streamId];

		if (!internal) return;

		if (internal.producers.audioProducer && !internal.producers.audioProducer.closed) {
			internal.producers.audioProducer.close();
		}
		if (internal.producers.videoProducer && !internal.producers.videoProducer.closed) {
			internal.producers.videoProducer.close();
		}

		delete this.externalStreamsInternal[streamId];
		delete this.state.externalStreams[streamId];

		pubsub.publish(ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM, {
			channelId: this.id,
			streamId,
		});
	};

	public updateExternalStream = (
		streamId: number,
		options: {
			title?: string;
			avatarUrl?: string;
			producers?: {
				audio?: Producer;
				video?: Producer;
			};
		},
	) => {
		const internal = this.externalStreamsInternal[streamId];

		if (!internal) return;

		const publicStream = this.state.externalStreams[streamId];

		if (!publicStream) return;

		if (options.title !== undefined) {
			internal.title = options.title;
			publicStream.title = options.title;
		}

		if (options.avatarUrl !== undefined) {
			internal.avatarUrl = options.avatarUrl;
			publicStream.avatarUrl = options.avatarUrl;
		}

		if (options.producers) {
			if (options.producers.audio !== undefined) {
				if (internal.producers.audioProducer && !internal.producers.audioProducer.closed) {
					internal.producers.audioProducer.close();
				}

				if (options.producers.audio) {
					internal.producers.audioProducer = options.producers.audio;
					this.setupExternalProducerCloseHandler(streamId, 'audio', options.producers.audio);

					pubsub.publishForChannel(this.id, ServerEvents.VOICE_NEW_PRODUCER, {
						channelId: this.id,
						remoteId: streamId,
						kind: StreamKind.EXTERNAL_AUDIO,
					});
				} else {
					delete internal.producers.audioProducer;
				}
			}

			if (options.producers.video !== undefined) {
				if (internal.producers.videoProducer && !internal.producers.videoProducer.closed) {
					internal.producers.videoProducer.close();
				}

				if (options.producers.video) {
					internal.producers.videoProducer = options.producers.video;
					this.setupExternalProducerCloseHandler(streamId, 'video', options.producers.video);

					pubsub.publishForChannel(this.id, ServerEvents.VOICE_NEW_PRODUCER, {
						channelId: this.id,
						remoteId: streamId,
						kind: StreamKind.EXTERNAL_VIDEO,
					});
				} else {
					delete internal.producers.videoProducer;
				}
			}

			publicStream.tracks = {
				audio: !!internal.producers.audioProducer,
				video: !!internal.producers.videoProducer,
			};
		}

		pubsub.publish(ServerEvents.VOICE_UPDATE_EXTERNAL_STREAM, {
			channelId: this.id,
			streamId,
			stream: publicStream,
		});
	};

	public getExternalStreamProducer = (streamId: number, kind: 'audio' | 'video'): Producer | undefined => {
		const internal = this.externalStreamsInternal[streamId];
		if (!internal) return undefined;

		return kind === 'audio' ? internal.producers.audioProducer : internal.producers.videoProducer;
	};

	public getRemoteIds = (userId: number): TRemoteProducerIds => {
		return {
			remoteVideoIds: Object.keys(this.videoProducers)
				.filter((id) => +id !== userId)
				.map((id) => +id),
			remoteAudioIds: Object.keys(this.audioProducers)
				.filter((id) => +id !== userId)
				.map((id) => +id),
			remoteScreenIds: Object.keys(this.screenProducers)
				.filter((id) => +id !== userId)
				.map((id) => +id),
			remoteScreenAudioIds: Object.keys(this.screenAudioProducers).map((id) => +id),
			remoteExternalStreamIds: Object.keys(this.externalStreamsInternal).map((id) => +id),
		};
	};

	public getExternalStreamTracks = (streamId: number): { audio: boolean; video: boolean } => {
		const internal = this.externalStreamsInternal[streamId];
		if (!internal) return { audio: false, video: false };

		return {
			audio: !!internal.producers.audioProducer,
			video: !!internal.producers.videoProducer,
		};
	};

	public static getListenInfo = () => {
		return {
			ip: webRtcServerListenInfo.ip,
			announcedAddress: webRtcServerListenInfo.announcedAddress,
			listenInfos: webRtcServerListenInfos,
		};
	};

	public getSpeakingUserIds = (): number[] => {
		return Array.from(this.speakingUserIds);
	};

	private addAudioProducerToVoiceActivityObserver = (userId: number, producer: Producer<AppData>) => {
		const observer = this.audioLevelObserver;

		if (!observer || observer.closed) {
			return;
		}

		const previousProducerId = this.voiceActivityProducerIdsByUser.get(userId);

		if (previousProducerId && previousProducerId !== producer.id) {
			this.voiceActivityUserIdsByProducer.delete(previousProducerId);

			observer.removeProducer({ producerId: previousProducerId }).catch((error) => {
				logger.debug('Failed to remove replaced producer from voice activity observer:', error);
			});
		}

		this.voiceActivityProducerIdsByUser.set(userId, producer.id);
		this.voiceActivityUserIdsByProducer.set(producer.id, userId);

		observer.addProducer({ producerId: producer.id }).catch((error) => {
			if (this.voiceActivityProducerIdsByUser.get(userId) === producer.id) {
				this.voiceActivityProducerIdsByUser.delete(userId);
				this.voiceActivityUserIdsByProducer.delete(producer.id);
			}

			logger.error('Failed to add producer to voice activity observer:', error);
		});
	};

	private removeAudioProducerFromVoiceActivityObserver = (userId: number, producer: Producer<AppData>) => {
		if (this.voiceActivityProducerIdsByUser.get(userId) === producer.id) {
			this.voiceActivityProducerIdsByUser.delete(userId);
		}

		this.voiceActivityUserIdsByProducer.delete(producer.id);
		this.setUserSpeaking(userId, false);
	};

	private handleVoiceActivityVolumes = (volumes: AudioLevelObserverVolume[]) => {
		const activeUserIds = new Set<number>();

		for (const { producer } of volumes) {
			const userId = this.voiceActivityUserIdsByProducer.get(producer.id);
			const user = userId === undefined ? undefined : this.getUser(userId);

			if (userId === undefined || !user || user.state.micMuted) {
				continue;
			}

			activeUserIds.add(userId);
			this.setUserSpeaking(userId, true);
		}

		for (const userId of this.speakingUserIds) {
			if (!activeUserIds.has(userId)) {
				this.scheduleUserSpeakingRelease(userId);
			}
		}
	};

	private handleVoiceActivitySilence = () => {
		for (const userId of this.speakingUserIds) {
			this.scheduleUserSpeakingRelease(userId);
		}
	};

	private scheduleUserSpeakingRelease = (userId: number) => {
		if (this.voiceActivityReleaseTimers.has(userId)) {
			return;
		}

		const timeout = setTimeout(() => {
			this.voiceActivityReleaseTimers.delete(userId);
			this.setUserSpeaking(userId, false);
		}, VOICE_ACTIVITY_RELEASE_DELAY_MS);

		this.voiceActivityReleaseTimers.set(userId, timeout);
	};

	private setUserSpeaking = (userId: number, isSpeaking: boolean) => {
		const releaseTimer = this.voiceActivityReleaseTimers.get(userId);

		if (releaseTimer) {
			clearTimeout(releaseTimer);
			this.voiceActivityReleaseTimers.delete(userId);
		}

		if (isSpeaking) {
			if (this.speakingUserIds.has(userId)) {
				return;
			}

			this.speakingUserIds.add(userId);
		} else {
			if (!this.speakingUserIds.delete(userId)) {
				return;
			}
		}

		pubsub.publishForChannel(this.id, ServerEvents.VOICE_ACTIVITY_UPDATE, {
			channelId: this.id,
			userId,
			isSpeaking,
		});
	};

	private startMediaLivenessMonitor = () => {
		if (this.mediaLivenessTimer) {
			return;
		}

		this.mediaLivenessTimer = setInterval(() => {
			void this.checkMediaLiveness();
		}, MEDIA_LIVENESS_CHECK_INTERVAL_MS);

		// Never let the heartbeat keep the process alive on its own.
		this.mediaLivenessTimer.unref?.();
	};

	private stopMediaLivenessMonitor = () => {
		if (this.mediaLivenessTimer) {
			clearInterval(this.mediaLivenessTimer);
			this.mediaLivenessTimer = undefined;
		}

		this.mediaLiveness.clear();
	};

	// True when the user is actively *receiving* media (has >= 1 consumer). We key
	// the watchdog on consumers, not producers: a consuming client sends periodic
	// RTCP receiver reports on its recv transport — a guaranteed, DTX-independent
	// inbound signal — so `bytesReceived` keeps advancing on a live path even when
	// no one is speaking. A producer-only user can legitimately go silent (muted /
	// alone) with no guaranteed inbound traffic, which would risk a false positive;
	// their signaling liveness is covered by the WS keepAlive instead. This also
	// matches the symptom we care about — "can't hear anyone" means the user has
	// audio consumers.
	private userHasActiveConsumer = (userId: number): boolean => {
		const userConsumers = this.consumers[userId];

		return !!userConsumers && Object.keys(userConsumers).length > 0;
	};

	private checkMediaLiveness = async () => {
		// Skip rather than overlap: on a large/busy channel a tick's getStats calls
		// can outrun the 5s interval, and overlapping runs would race on the
		// liveness map and pile up worker IPC. One batch in flight at a time.
		if (this.mediaLivenessCheckInFlight) {
			return;
		}

		this.mediaLivenessCheckInFlight = true;

		try {
			const now = Date.now();
			const userIds = this.state.users.map((user) => user.userId);

			await Promise.all(
				userIds.map(async (userId) => {
					try {
						const consumerTransport = this.consumerTransports[userId];
						const consumerConnected =
							!!consumerTransport && !consumerTransport.closed && consumerTransport.dtlsState === 'connected';

						// Watch only the recv (consumer) transport of a user actively
						// receiving media: it carries the periodic RTCP receiver reports
						// that guarantee a DTX-proof inbound signal. We deliberately do NOT
						// fold in the producer transport — it negotiates ICE independently,
						// so a producer that flaps would keep changing the transport key and
						// rebaseline the timer, masking a genuinely dead consumer path.
						// While the recv transport is still negotiating / gone, or the user
						// is not consuming, there is no signal to act on.
						if (!consumerConnected || !this.userHasActiveConsumer(userId)) {
							this.mediaLiveness.delete(userId);
							return;
						}

						const [stats] = await consumerTransport.getStats();
						const bytesReceived = stats?.bytesReceived ?? 0;

						// The user may have left or been torn down while getStats was inflight.
						if (!this.getUser(userId)) {
							this.mediaLiveness.delete(userId);
							return;
						}

						// Additive jitter, only consumed when (re)baselining, spreads
						// simultaneous failures across users so a global media outage does
						// not stampede recovery.
						const baselineTimeoutMs = MEDIA_LIVENESS_TIMEOUT_MS + Math.random() * MEDIA_LIVENESS_JITTER_MS;
						const { next, shouldSignalFailure } = evaluateMediaLiveness(
							this.mediaLiveness.get(userId),
							{ transportKey: consumerTransport.id, bytesReceived, now },
							baselineTimeoutMs,
						);

						this.mediaLiveness.set(userId, next);

						if (shouldSignalFailure) {
							// Per-fire detail (with ids) goes to app.log; the aggregated,
							// rate-limited Sentry summary is emitted by the telemetry module.
							logger.warn(
								`[voice] media-liveness timeout for user ${userId} in channel ${this.id}: no bytes received for ${
									now - next.lastProgressAt
								}ms, signalling transport failure`,
							);

							recordMediaLivenessFailure(this.id, userId);

							pubsub.publishFor(userId, ServerEvents.VOICE_TRANSPORT_FAILED, {
								userId,
							});
						}
					} catch (error) {
						// A transport can close mid-iteration; drop the baseline and let the
						// next tick re-evaluate from scratch.
						logger.debug('Media-liveness check failed for user %s: %o', userId, error);
						this.mediaLiveness.delete(userId);
					}
				}),
			);
		} finally {
			this.mediaLivenessCheckInFlight = false;
		}
	};

	private clearAllVoiceActivity = () => {
		for (const timeout of this.voiceActivityReleaseTimers.values()) {
			clearTimeout(timeout);
		}

		this.voiceActivityReleaseTimers.clear();
		this.voiceActivityProducerIdsByUser.clear();
		this.voiceActivityUserIdsByProducer.clear();

		for (const userId of this.speakingUserIds) {
			pubsub.publishForChannel(this.id, ServerEvents.VOICE_ACTIVITY_UPDATE, {
				channelId: this.id,
				userId,
				isSpeaking: false,
			});
		}

		this.speakingUserIds.clear();
	};
}

export { VoiceRuntime };
