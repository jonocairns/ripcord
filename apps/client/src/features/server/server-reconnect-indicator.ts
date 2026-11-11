import type { TConnectionState } from '@/lib/connection-state';

const SERVER_RECONNECT_INDICATOR_DELAY_MS = 2_000;

// Both now and phase.since use performance.now(), never Date.now().
const getServerReconnectIndicatorDelayMs = (phase: TConnectionState['phase'], now: number): number | undefined => {
	if (phase.name !== 'recovering') return undefined;
	const elapsedMs = Math.max(now - phase.since, 0);
	return Math.max(SERVER_RECONNECT_INDICATOR_DELAY_MS - elapsedMs, 0);
};

const getServerReconnectIndicatorText = (online: boolean): { title: string; detail: string } =>
	online
		? { title: 'Reconnecting...', detail: 'Trying to reach the server.' }
		: { title: "You're offline", detail: 'Will reconnect when your network is back.' };

export { getServerReconnectIndicatorDelayMs, getServerReconnectIndicatorText, SERVER_RECONNECT_INDICATOR_DELAY_MS };
