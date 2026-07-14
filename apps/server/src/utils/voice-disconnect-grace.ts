import { logger } from '../logger';

const VOICE_DISCONNECT_GRACE_MS = 60_000;
const FALLBACK_VOICE_DISCONNECT_GRACE_MS = 5_000;

type TVoiceDisconnectCounterKey = 'graceScheduled' | 'graceCancelled' | 'graceExpired' | 'missingClientInstanceId';
type TVoiceDisconnectLogLevel = 'info' | 'warn';

type TVoiceDisconnectGraceTimer = {
	cancel: () => void;
};

type TVoiceDisconnectGraceScheduler = {
	now: () => number;
	schedule: (callback: () => void, delayMs: number) => TVoiceDisconnectGraceTimer;
};

type TVoiceDisconnectEventFields = {
	reconnectAttemptId?: string;
	userId: number;
	clientInstanceId?: string;
	requestedChannelId?: number;
	activeChannelId?: number;
	graceAgeMs?: number;
	ttlRemainingMs?: number;
	wsCloseCode?: number;
	fallback?: boolean;
};

type TPendingVoiceDisconnect = {
	clientInstanceId?: string;
	userId: number;
	channelId: number;
	// Incarnation token of the seat at disconnect time. Reconnect adoption
	// compares it against the runtime's current token so a connection never
	// adopts a seat that a newer session replaced while it was away.
	seatIncarnation?: symbol;
	timer: TVoiceDisconnectGraceTimer;
	scheduledAt: number;
	expiresAt: number;
	wsCloseCode?: number;
};

type TSchedulePendingVoiceDisconnectOptions = {
	clientInstanceId?: string;
	userId: number;
	channelId: number;
	seatIncarnation?: symbol;
	wsCloseCode?: number;
	finalize: () => void;
	ttlMs?: number;
	fallbackTtlMs?: number;
};
type TScheduleTrackedDisconnectOptions = {
	clientInstanceId: string;
	userId: number;
	channelId: number;
	seatIncarnation?: symbol;
	wsCloseCode?: number;
	finalize: () => void;
	ttlMs: number;
};
type TScheduleFallbackDisconnectOptions = {
	userId: number;
	channelId: number;
	wsCloseCode?: number;
	finalize: () => void;
	fallbackTtlMs: number;
};

const defaultVoiceDisconnectGraceScheduler: TVoiceDisconnectGraceScheduler = {
	now: Date.now,
	schedule: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return { cancel: () => clearTimeout(timer) };
	},
};

let voiceDisconnectGraceScheduler = defaultVoiceDisconnectGraceScheduler;
const pendingVoiceDisconnects = new Map<string, TPendingVoiceDisconnect>();
const fallbackVoiceDisconnectTimers = new Set<TVoiceDisconnectGraceTimer>();
const voiceDisconnectCounterKeys: TVoiceDisconnectCounterKey[] = [
	'graceScheduled',
	'graceCancelled',
	'graceExpired',
	'missingClientInstanceId',
];

const voiceDisconnectCounters: Record<TVoiceDisconnectCounterKey, number> = {
	graceScheduled: 0,
	graceCancelled: 0,
	graceExpired: 0,
	missingClientInstanceId: 0,
};

const getPendingVoiceDisconnectKey = (userId: number, clientInstanceId: string) => {
	return `${userId}:${clientInstanceId}`;
};

const incrementCounter = (key: TVoiceDisconnectCounterKey) => {
	voiceDisconnectCounters[key] += 1;
	return voiceDisconnectCounters[key];
};

const logVoiceDisconnectEvent = (
	level: TVoiceDisconnectLogLevel,
	event: string,
	fields: TVoiceDisconnectEventFields,
	counterKey?: TVoiceDisconnectCounterKey,
) => {
	const payload = {
		scope: 'voice_disconnect_grace',
		event,
		...fields,
		counter:
			counterKey === undefined
				? undefined
				: {
						name: counterKey,
						value: voiceDisconnectCounters[counterKey],
					},
	};

	if (level === 'warn') {
		logger.warn('[voice-reconnect] %s', JSON.stringify(payload));
		return;
	}

	logger.info('[voice-reconnect] %s', JSON.stringify(payload));
};

const clearPendingVoiceDisconnect = (clientInstanceId?: string, userId?: number) => {
	if (!clientInstanceId || userId === undefined) {
		return false;
	}

	const pendingDisconnectKey = getPendingVoiceDisconnectKey(userId, clientInstanceId);
	const pendingDisconnect = pendingVoiceDisconnects.get(pendingDisconnectKey);

	if (!pendingDisconnect) {
		return false;
	}

	pendingDisconnect.timer.cancel();
	pendingVoiceDisconnects.delete(pendingDisconnectKey);

	incrementCounter('graceCancelled');

	const now = voiceDisconnectGraceScheduler.now();

	logVoiceDisconnectEvent(
		'info',
		'grace_cancelled',
		{
			userId: pendingDisconnect.userId,
			clientInstanceId,
			activeChannelId: pendingDisconnect.channelId,
			graceAgeMs: now - pendingDisconnect.scheduledAt,
			ttlRemainingMs: Math.max(0, pendingDisconnect.expiresAt - now),
			wsCloseCode: pendingDisconnect.wsCloseCode,
		},
		'graceCancelled',
	);

	return true;
};

const getPendingVoiceReconnectChannelId = (clientInstanceId: string | undefined, userId: number) => {
	if (!clientInstanceId) {
		return undefined;
	}

	const pendingDisconnect = pendingVoiceDisconnects.get(getPendingVoiceDisconnectKey(userId, clientInstanceId));

	if (!pendingDisconnect) {
		return undefined;
	}

	return pendingDisconnect.channelId;
};

const getPendingVoiceReconnectSeatIncarnation = (clientInstanceId: string | undefined, userId: number) => {
	if (!clientInstanceId) {
		return undefined;
	}

	return pendingVoiceDisconnects.get(getPendingVoiceDisconnectKey(userId, clientInstanceId))?.seatIncarnation;
};

const getPendingVoiceReconnectChannelIdsOwnedElsewhere = (userId: number, clientInstanceId?: string) => {
	const channelIds: number[] = [];

	pendingVoiceDisconnects.forEach((pendingDisconnect) => {
		if (pendingDisconnect.userId !== userId) {
			return;
		}

		if (clientInstanceId !== undefined && pendingDisconnect.clientInstanceId === clientInstanceId) {
			return;
		}

		channelIds.push(pendingDisconnect.channelId);
	});

	return channelIds;
};

const scheduleTrackedDisconnect = ({
	clientInstanceId,
	userId,
	channelId,
	seatIncarnation,
	wsCloseCode,
	finalize,
	ttlMs,
}: TScheduleTrackedDisconnectOptions) => {
	clearPendingVoiceDisconnect(clientInstanceId, userId);

	const scheduledAt = voiceDisconnectGraceScheduler.now();
	const expiresAt = scheduledAt + ttlMs;
	const pendingDisconnectKey = getPendingVoiceDisconnectKey(userId, clientInstanceId);
	const timer = voiceDisconnectGraceScheduler.schedule(() => {
		pendingVoiceDisconnects.delete(pendingDisconnectKey);
		incrementCounter('graceExpired');

		logVoiceDisconnectEvent(
			'info',
			'grace_expired',
			{
				userId,
				clientInstanceId,
				activeChannelId: channelId,
				graceAgeMs: voiceDisconnectGraceScheduler.now() - scheduledAt,
				ttlRemainingMs: 0,
				wsCloseCode,
			},
			'graceExpired',
		);

		finalize();
	}, ttlMs);

	pendingVoiceDisconnects.set(pendingDisconnectKey, {
		clientInstanceId,
		userId,
		channelId,
		seatIncarnation,
		timer,
		scheduledAt,
		expiresAt,
		wsCloseCode,
	});

	incrementCounter('graceScheduled');

	logVoiceDisconnectEvent(
		'info',
		'grace_scheduled',
		{
			userId,
			clientInstanceId,
			activeChannelId: channelId,
			graceAgeMs: 0,
			ttlRemainingMs: ttlMs,
			wsCloseCode,
		},
		'graceScheduled',
	);
};

const scheduleFallbackDisconnect = ({
	userId,
	channelId,
	wsCloseCode,
	finalize,
	fallbackTtlMs,
}: TScheduleFallbackDisconnectOptions) => {
	incrementCounter('missingClientInstanceId');

	logVoiceDisconnectEvent(
		'warn',
		'missing_client_instance_id',
		{
			userId,
			activeChannelId: channelId,
			graceAgeMs: 0,
			ttlRemainingMs: fallbackTtlMs,
			wsCloseCode,
			fallback: true,
		},
		'missingClientInstanceId',
	);

	incrementCounter('graceScheduled');

	logVoiceDisconnectEvent(
		'info',
		'grace_scheduled',
		{
			userId,
			activeChannelId: channelId,
			graceAgeMs: 0,
			ttlRemainingMs: fallbackTtlMs,
			wsCloseCode,
			fallback: true,
		},
		'graceScheduled',
	);

	const scheduledAt = voiceDisconnectGraceScheduler.now();
	const timer = voiceDisconnectGraceScheduler.schedule(() => {
		fallbackVoiceDisconnectTimers.delete(timer);
		incrementCounter('graceExpired');

		logVoiceDisconnectEvent(
			'info',
			'grace_expired',
			{
				userId,
				activeChannelId: channelId,
				graceAgeMs: voiceDisconnectGraceScheduler.now() - scheduledAt,
				ttlRemainingMs: 0,
				wsCloseCode,
				fallback: true,
			},
			'graceExpired',
		);

		finalize();
	}, fallbackTtlMs);

	fallbackVoiceDisconnectTimers.add(timer);
};

const schedulePendingVoiceDisconnect = ({
	clientInstanceId,
	userId,
	channelId,
	seatIncarnation,
	wsCloseCode,
	finalize,
	ttlMs = VOICE_DISCONNECT_GRACE_MS,
	fallbackTtlMs = FALLBACK_VOICE_DISCONNECT_GRACE_MS,
}: TSchedulePendingVoiceDisconnectOptions) => {
	if (!clientInstanceId) {
		scheduleFallbackDisconnect({
			userId,
			channelId,
			wsCloseCode,
			finalize,
			fallbackTtlMs,
		});
		return;
	}

	scheduleTrackedDisconnect({
		clientInstanceId,
		userId,
		channelId,
		seatIncarnation,
		wsCloseCode,
		finalize,
		ttlMs,
	});
};

const getVoiceDisconnectGraceCounters = () => ({
	...voiceDisconnectCounters,
});

const resetVoiceDisconnectGraceForTests = () => {
	pendingVoiceDisconnects.forEach((pendingDisconnect) => {
		pendingDisconnect.timer.cancel();
	});

	pendingVoiceDisconnects.clear();
	fallbackVoiceDisconnectTimers.forEach((timer) => {
		timer.cancel();
	});
	fallbackVoiceDisconnectTimers.clear();

	voiceDisconnectCounterKeys.forEach((key) => {
		voiceDisconnectCounters[key] = 0;
	});
};

const setVoiceDisconnectGraceSchedulerForTests = (scheduler?: TVoiceDisconnectGraceScheduler) => {
	voiceDisconnectGraceScheduler = scheduler ?? defaultVoiceDisconnectGraceScheduler;
};

export type { TVoiceDisconnectGraceScheduler, TVoiceDisconnectGraceTimer };
export {
	clearPendingVoiceDisconnect,
	FALLBACK_VOICE_DISCONNECT_GRACE_MS,
	getPendingVoiceReconnectChannelId,
	getPendingVoiceReconnectChannelIdsOwnedElsewhere,
	getPendingVoiceReconnectSeatIncarnation,
	getVoiceDisconnectGraceCounters,
	resetVoiceDisconnectGraceForTests,
	schedulePendingVoiceDisconnect,
	setVoiceDisconnectGraceSchedulerForTests,
	VOICE_DISCONNECT_GRACE_MS,
};
