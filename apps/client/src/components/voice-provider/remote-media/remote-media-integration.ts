import { StreamKind, type TExternalStream } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import type {
	TWatchedExternalStreamsSnapshot,
	TWatchedRemoteStreamsSnapshot,
} from '@/features/server/voice/voice-session-machine';
import type { TRemoteMediaLedgerStore } from './remote-media-ledger-store';
import { isRemoteConsumeStartCurrent, type TRemoteMediaRepairIdentity } from './remote-media-subscriptions';
import { getPendingStreamKey, type TExternalStreamTrackPresence } from './use-pending-streams';
import type { useRemoteMediaSubscriptions } from './use-remote-media-subscriptions';
import type { TExternalStreamsMap } from './use-remote-streams';

type TRemoteMediaIntegrationInputs = Pick<
	ReturnType<typeof useRemoteMediaSubscriptions>,
	'markConsumeStarted' | 'markWatchRequested' | 'markRetryRequested' | 'addPendingStream'
> & {
	currentVoiceChannelId: number | undefined;
	ledgerStore: TRemoteMediaLedgerStore;
	currentChannelExternalStreams: Record<number, TExternalStream>;
	externalStreams: TExternalStreamsMap;
	getRtpCapabilities: () => RtpCapabilities | null;
	clearRemoteMediaExternalStream: (streamId: number) => void;
	removeExternalStream: (streamId: number) => void;
	log: (message: string, context: { remoteId: number; kind: StreamKind }) => void;
};

// Connects projections and identity checks to their authoritative owners. It
// acquires no media and owns neither ledger state nor transports/retry policy.
const createRemoteMediaIntegration = (getInputs: () => TRemoteMediaIntegrationInputs) => {
	let active = false;
	let lifecycleGeneration = 0;
	const activate = (): (() => void) => {
		active = true;
		const generation = ++lifecycleGeneration;
		return () => {
			if (!active || generation !== lifecycleGeneration) return;
			active = false;
		};
	};
	const getExternalStreamTrackPresence = (): TExternalStreamTrackPresence => {
		const tracks: TExternalStreamTrackPresence = {};
		for (const [id, stream] of Object.entries(getInputs().currentChannelExternalStreams)) {
			tracks[Number(id)] = stream.tracks;
		}
		return tracks;
	};
	const publishRemoteMediaConsumeStarted = (
		remoteId: number,
		kind: StreamKind,
		producerId: string | undefined,
		consumeGeneration: number,
		isManualRetry: boolean,
		signal: AbortSignal,
	): Promise<boolean> => {
		if (!active || signal.aborted) return Promise.resolve(false);
		const generation = lifecycleGeneration;

		getInputs().markConsumeStarted(remoteId, kind, producerId, consumeGeneration, isManualRetry);
		return Promise.resolve(
			isRemoteConsumeStartCurrent(
				getInputs().ledgerStore.getSnapshot(),
				{ remoteId, kind, expectedProducerId: producerId },
				consumeGeneration,
			) &&
				active &&
				generation === lifecycleGeneration,
		);
	};

	const isRemoteMediaProducerCurrent = (remoteId: number, kind: StreamKind, producerId: string): boolean => {
		if (!active) return false;
		const subscription = getInputs().ledgerStore.getSnapshot().get(getPendingStreamKey(remoteId, kind));
		return (
			subscription?.producerPresent === true &&
			(subscription.producerId === undefined || subscription.producerId === producerId)
		);
	};
	const isRemoteMediaRepairIdentityCurrent = (identity: TRemoteMediaRepairIdentity): boolean => {
		if (!active) return false;
		const inputs = getInputs();
		const subscription = inputs.ledgerStore.getSnapshot().get(identity.key);
		return (
			inputs.currentVoiceChannelId === identity.channelId &&
			subscription?.producerPresent === true &&
			subscription.remoteId === identity.remoteId &&
			subscription.kind === identity.kind &&
			subscription.producerId === identity.producerId
		);
	};
	const getPendingStreamProducerId = (remoteId: number, kind: StreamKind): string | undefined =>
		getInputs().ledgerStore.getPendingStreams().get(getPendingStreamKey(remoteId, kind))?.producerId;
	const captureWatchedRemoteStreams = (): TWatchedRemoteStreamsSnapshot => {
		const remoteUserStreams: Record<number, StreamKind[]> = {};
		const externalStreams: Record<number, TWatchedExternalStreamsSnapshot> = {};
		for (const subscription of getInputs().ledgerStore.getSnapshot().values()) {
			if (!subscription.desired || subscription.kind === StreamKind.AUDIO) continue;
			if (
				subscription.kind === StreamKind.VIDEO ||
				subscription.kind === StreamKind.SCREEN ||
				subscription.kind === StreamKind.SCREEN_AUDIO
			) {
				const watchedKinds = remoteUserStreams[subscription.remoteId] ?? [];
				watchedKinds.push(subscription.kind);
				remoteUserStreams[subscription.remoteId] = watchedKinds;
			} else if (subscription.kind === StreamKind.EXTERNAL_AUDIO || subscription.kind === StreamKind.EXTERNAL_VIDEO) {
				const watched = externalStreams[subscription.remoteId] ?? { audio: false, video: false };
				externalStreams[subscription.remoteId] = {
					audio: watched.audio || subscription.kind === StreamKind.EXTERNAL_AUDIO,
					video: watched.video || subscription.kind === StreamKind.EXTERNAL_VIDEO,
				};
			}
		}
		return { remoteUserStreams, externalStreams };
	};
	const removeExternalStreamAndSubscription = (streamId: number): void => {
		if (!active) return;
		getInputs().clearRemoteMediaExternalStream(streamId);
		getInputs().removeExternalStream(streamId);
	};
	const acceptStream = (remoteId: number, kind: StreamKind): void => {
		if (!active) return;
		getInputs().markWatchRequested(remoteId, kind, getExternalStreamTrackPresence());
	};
	const retryRemoteMedia = (remoteId: number, kind: StreamKind): void => {
		if (!active) return;
		if (!getInputs().getRtpCapabilities()) {
			getInputs().log('Cannot retry remote media before voice is initialized', { remoteId, kind });
			return;
		}
		getInputs().markRetryRequested(remoteId, kind, getExternalStreamTrackPresence());
	};
	const reconcileExternalStreams = (inputs = getInputs()): void => {
		if (!active) return;
		const tracks = getExternalStreamTrackPresence();
		for (const [id, stream] of Object.entries(inputs.currentChannelExternalStreams)) {
			const remoteId = Number(id);
			const activeStream = inputs.externalStreams[remoteId];
			for (const kind of [StreamKind.EXTERNAL_AUDIO, StreamKind.EXTERNAL_VIDEO] as const) {
				const key = getPendingStreamKey(remoteId, kind);
				const trackPresent = kind === StreamKind.EXTERNAL_AUDIO ? stream.tracks.audio : stream.tracks.video;
				const activeTrack = kind === StreamKind.EXTERNAL_AUDIO ? activeStream?.audioStream : activeStream?.videoStream;
				if (
					trackPresent &&
					!activeTrack &&
					(!inputs.ledgerStore.getPendingStreams().has(key) ||
						inputs.ledgerStore.getSnapshot().get(key)?.desired === true)
				) {
					inputs.addPendingStream(remoteId, kind, undefined, tracks);
				}
			}
		}
	};
	return {
		activate,
		publishRemoteMediaConsumeStarted,
		isRemoteMediaProducerCurrent,
		isRemoteMediaRepairIdentityCurrent,
		getPendingStreamProducerId,
		captureWatchedRemoteStreams,
		removeExternalStreamAndSubscription,
		acceptStream,
		retryRemoteMedia,
		reconcileExternalStreams,
	};
};

const mountRemoteMediaIntegration = (integration: ReturnType<typeof createRemoteMediaIntegration>): (() => void) =>
	integration.activate();

export type { TRemoteMediaIntegrationInputs };
export { createRemoteMediaIntegration, mountRemoteMediaIntegration };
