import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import type { TRemoteMediaRepairIdentity } from './remote-media-subscriptions';
import { isExternalTrackPresent, type TExternalStreamTrackPresence } from './use-pending-streams';

type TRemoteMediaProducerSnapshotSlot = {
	present: boolean;
	producerId?: string;
};

type TRemoteMediaProducerRepairPorts = {
	getProducers: () => Promise<TRemoteProducerIds>;
	isIdentityCurrent: (identity: TRemoteMediaRepairIdentity) => boolean;
	markProducerMissing: (identity: TRemoteMediaRepairIdentity) => void;
	markProducerPresent: (
		identity: TRemoteMediaRepairIdentity,
		producerId: string | undefined,
		externalStreamTracks: TExternalStreamTrackPresence | undefined,
	) => void;
	consume: (identity: TRemoteMediaRepairIdentity) => Promise<unknown>;
};

type TRemoteMediaProducerRepairResult = 'completed' | 'missing' | 'replaced' | 'superseded';

const legacySnapshotSlot = (
	present: boolean,
	identity: TRemoteMediaRepairIdentity,
): TRemoteMediaProducerSnapshotSlot => ({
	present,
	producerId: present ? identity.producerId : undefined,
});

const getRemoteProducerSnapshotSlot = (
	producers: TRemoteProducerIds,
	identity: TRemoteMediaRepairIdentity,
	externalStreamTracks?: TExternalStreamTrackPresence,
): TRemoteMediaProducerSnapshotSlot => {
	switch (identity.kind) {
		case StreamKind.AUDIO: {
			const producer = producers.remoteAudioProducers?.find((item) => item.remoteId === identity.remoteId);
			return producers.remoteAudioProducers
				? { present: producer !== undefined, producerId: producer?.producerId }
				: legacySnapshotSlot(producers.remoteAudioIds.includes(identity.remoteId), identity);
		}
		case StreamKind.VIDEO: {
			const producer = producers.remoteVideoProducers?.find((item) => item.remoteId === identity.remoteId);
			return producers.remoteVideoProducers
				? { present: producer !== undefined, producerId: producer?.producerId }
				: legacySnapshotSlot(producers.remoteVideoIds.includes(identity.remoteId), identity);
		}
		case StreamKind.SCREEN: {
			const producer = producers.remoteScreenProducers?.find((item) => item.remoteId === identity.remoteId);
			return producers.remoteScreenProducers
				? { present: producer !== undefined, producerId: producer?.producerId }
				: legacySnapshotSlot(producers.remoteScreenIds.includes(identity.remoteId), identity);
		}
		case StreamKind.SCREEN_AUDIO: {
			const producer = producers.remoteScreenAudioProducers?.find((item) => item.remoteId === identity.remoteId);
			return producers.remoteScreenAudioProducers
				? { present: producer !== undefined, producerId: producer?.producerId }
				: legacySnapshotSlot(producers.remoteScreenAudioIds.includes(identity.remoteId), identity);
		}
		case StreamKind.EXTERNAL_AUDIO: {
			const producer = producers.remoteExternalAudioProducers?.find((item) => item.streamId === identity.remoteId);
			const tracks = producers.externalStreamTracks?.[identity.remoteId] ?? externalStreamTracks?.[identity.remoteId];
			return producers.remoteExternalAudioProducers
				? { present: producer !== undefined, producerId: producer?.producerId }
				: legacySnapshotSlot(
						producers.remoteExternalStreamIds.includes(identity.remoteId) && isExternalTrackPresent(tracks, 'audio'),
						identity,
					);
		}
		case StreamKind.EXTERNAL_VIDEO: {
			const producer = producers.remoteExternalVideoProducers?.find((item) => item.streamId === identity.remoteId);
			const tracks = producers.externalStreamTracks?.[identity.remoteId] ?? externalStreamTracks?.[identity.remoteId];
			return producers.remoteExternalVideoProducers
				? { present: producer !== undefined, producerId: producer?.producerId }
				: legacySnapshotSlot(
						producers.remoteExternalStreamIds.includes(identity.remoteId) && isExternalTrackPresent(tracks, 'video'),
						identity,
					);
		}
	}
};

const runRemoteMediaProducerRepair = async (
	identity: TRemoteMediaRepairIdentity,
	externalStreamTracks: TExternalStreamTrackPresence | undefined,
	ports: TRemoteMediaProducerRepairPorts,
): Promise<TRemoteMediaProducerRepairResult> => {
	if (!ports.isIdentityCurrent(identity)) {
		return 'superseded';
	}

	const producers = await ports.getProducers();

	if (!ports.isIdentityCurrent(identity)) {
		return 'superseded';
	}

	const snapshotSlot = getRemoteProducerSnapshotSlot(producers, identity, externalStreamTracks);

	if (!snapshotSlot.present) {
		ports.markProducerMissing(identity);
		return 'missing';
	}

	if (snapshotSlot.producerId !== identity.producerId) {
		ports.markProducerPresent(
			identity,
			snapshotSlot.producerId,
			producers.externalStreamTracks ?? externalStreamTracks,
		);
		return 'replaced';
	}

	await ports.consume(identity);

	return ports.isIdentityCurrent(identity) ? 'completed' : 'superseded';
};

export {
	getRemoteProducerSnapshotSlot,
	runRemoteMediaProducerRepair,
	type TRemoteMediaProducerRepairPorts,
	type TRemoteMediaProducerRepairResult,
};
