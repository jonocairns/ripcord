import type { AudioVideoRefs } from './types';

const createEmptyAudioVideoRefs = (): AudioVideoRefs => ({
	videoRef: { current: null },
	audioRef: { current: null },
	screenShareRef: { current: null },
	screenShareAudioRef: { current: null },
	externalAudioRef: { current: null },
	externalVideoRef: { current: null },
});

const createMediaElementRefCache = () => {
	const refsByRemoteId = new Map<number, AudioVideoRefs>();
	const getOrCreateRefs = (remoteId: number): AudioVideoRefs => {
		const existing = refsByRemoteId.get(remoteId);
		if (existing) return existing;
		const refs = createEmptyAudioVideoRefs();
		refsByRemoteId.set(remoteId, refs);
		return refs;
	};
	const clear = (): void => refsByRemoteId.clear();
	const prune = (
		channelId: number | undefined,
		users: Record<number, unknown> | undefined,
		externalStreams: Record<number, unknown> | undefined,
	): void => {
		if (channelId === undefined) {
			clear();
			return;
		}
		const validIds = new Set([...Object.keys(users ?? {}), ...Object.keys(externalStreams ?? {})].map(Number));
		for (const id of refsByRemoteId.keys()) if (!validIds.has(id)) refsByRemoteId.delete(id);
	};
	return { getOrCreateRefs, clear, prune };
};

export { createEmptyAudioVideoRefs, createMediaElementRefCache };
