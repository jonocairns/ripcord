import { useEffect, useRef } from 'react';
import { useServerStore } from '@/features/server/slice';
import { createMediaElementRefCache } from '../media-element-refs';

const useMediaElementRefs = (currentVoiceChannelId: number | undefined) => {
	const cacheRef = useRef<ReturnType<typeof createMediaElementRefCache> | undefined>(undefined);
	if (!cacheRef.current) cacheRef.current = createMediaElementRefCache();
	const cache = cacheRef.current;
	const users = useServerStore((state) =>
		currentVoiceChannelId !== undefined ? state.voiceMap[currentVoiceChannelId]?.users : undefined,
	);
	const externalStreams = useServerStore((state) =>
		currentVoiceChannelId !== undefined ? state.externalStreamsMap[currentVoiceChannelId] : undefined,
	);
	useEffect(() => {
		cache.prune(currentVoiceChannelId, users, externalStreams);
	}, [cache, currentVoiceChannelId, users, externalStreams]);
	return cache;
};

export { useMediaElementRefs };
