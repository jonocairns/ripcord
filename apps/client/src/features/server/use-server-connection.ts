import { useSyncExternalStore } from 'react';
import type { TConnectionState } from '@/lib/connection-state';
import { getServerConnectionState, subscribeServerConnectionState } from '@/lib/trpc';

// Selectors must return a primitive or a reference taken from the state:
// useSyncExternalStore compares consecutive snapshots with Object.is.
const useServerConnectionSelector = <T>(selector: (state: TConnectionState) => T): T =>
	useSyncExternalStore(
		subscribeServerConnectionState,
		() => selector(getServerConnectionState()),
		() => selector(getServerConnectionState()),
	);

export { useServerConnectionSelector };
