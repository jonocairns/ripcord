import { logger } from '../logger';

const VOICE_DISCONNECT_GRACE_MS = 60_000;
const FALLBACK_VOICE_DISCONNECT_GRACE_MS = 5_000;

type TVoiceDisconnectCounterKey =
  | 'graceScheduled'
  | 'graceCancelled'
  | 'graceExpired'
  | 'missingClientInstanceId';
type TVoiceDisconnectLogLevel = 'info' | 'warn';

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
  timer: ReturnType<typeof setTimeout>;
  scheduledAt: number;
  expiresAt: number;
  wsCloseCode?: number;
};

type TSchedulePendingVoiceDisconnectOptions = {
  clientInstanceId?: string;
  userId: number;
  channelId: number;
  wsCloseCode?: number;
  finalize: () => void;
  ttlMs?: number;
  fallbackTtlMs?: number;
};
type TScheduleTrackedDisconnectOptions = {
  clientInstanceId: string;
  userId: number;
  channelId: number;
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

const pendingVoiceDisconnects = new Map<string, TPendingVoiceDisconnect>();
const fallbackVoiceDisconnectTimers = new Set<ReturnType<typeof setTimeout>>();
const voiceDisconnectCounterKeys: TVoiceDisconnectCounterKey[] = [
  'graceScheduled',
  'graceCancelled',
  'graceExpired',
  'missingClientInstanceId'
];

const voiceDisconnectCounters: Record<TVoiceDisconnectCounterKey, number> = {
  graceScheduled: 0,
  graceCancelled: 0,
  graceExpired: 0,
  missingClientInstanceId: 0
};

const getPendingVoiceDisconnectKey = (
  userId: number,
  clientInstanceId: string
) => {
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
  counterKey?: TVoiceDisconnectCounterKey
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
            value: voiceDisconnectCounters[counterKey]
          }
  };

  if (level === 'warn') {
    logger.warn('[voice-reconnect] %s', JSON.stringify(payload));
    return;
  }

  logger.info('[voice-reconnect] %s', JSON.stringify(payload));
};

const clearPendingVoiceDisconnect = (
  clientInstanceId?: string,
  userId?: number
) => {
  if (!clientInstanceId || userId === undefined) {
    return false;
  }

  const pendingDisconnectKey = getPendingVoiceDisconnectKey(
    userId,
    clientInstanceId
  );
  const pendingDisconnect = pendingVoiceDisconnects.get(pendingDisconnectKey);

  if (!pendingDisconnect) {
    return false;
  }

  clearTimeout(pendingDisconnect.timer);
  pendingVoiceDisconnects.delete(pendingDisconnectKey);

  incrementCounter('graceCancelled');

  const now = Date.now();

  logVoiceDisconnectEvent(
    'info',
    'grace_cancelled',
    {
      userId: pendingDisconnect.userId,
      clientInstanceId,
      activeChannelId: pendingDisconnect.channelId,
      graceAgeMs: now - pendingDisconnect.scheduledAt,
      ttlRemainingMs: Math.max(0, pendingDisconnect.expiresAt - now),
      wsCloseCode: pendingDisconnect.wsCloseCode
    },
    'graceCancelled'
  );

  return true;
};

const getPendingVoiceReconnectChannelId = (
  clientInstanceId: string | undefined,
  userId: number
) => {
  if (!clientInstanceId) {
    return undefined;
  }

  const pendingDisconnect = pendingVoiceDisconnects.get(
    getPendingVoiceDisconnectKey(userId, clientInstanceId)
  );

  if (!pendingDisconnect) {
    return undefined;
  }

  return pendingDisconnect.channelId;
};

const getPendingVoiceReconnectChannelIdsOwnedElsewhere = (
  userId: number,
  clientInstanceId?: string
) => {
  const channelIds: number[] = [];

  pendingVoiceDisconnects.forEach((pendingDisconnect) => {
    if (pendingDisconnect.userId !== userId) {
      return;
    }

    if (
      clientInstanceId !== undefined &&
      pendingDisconnect.clientInstanceId === clientInstanceId
    ) {
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
  wsCloseCode,
  finalize,
  ttlMs
}: TScheduleTrackedDisconnectOptions) => {
  clearPendingVoiceDisconnect(clientInstanceId, userId);

  const scheduledAt = Date.now();
  const expiresAt = scheduledAt + ttlMs;
  const pendingDisconnectKey = getPendingVoiceDisconnectKey(
    userId,
    clientInstanceId
  );
  const timer = setTimeout(() => {
    pendingVoiceDisconnects.delete(pendingDisconnectKey);
    incrementCounter('graceExpired');

    logVoiceDisconnectEvent(
      'info',
      'grace_expired',
      {
        userId,
        clientInstanceId,
        activeChannelId: channelId,
        graceAgeMs: Date.now() - scheduledAt,
        ttlRemainingMs: 0,
        wsCloseCode
      },
      'graceExpired'
    );

    finalize();
  }, ttlMs);

  pendingVoiceDisconnects.set(pendingDisconnectKey, {
    clientInstanceId,
    userId,
    channelId,
    timer,
    scheduledAt,
    expiresAt,
    wsCloseCode
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
      wsCloseCode
    },
    'graceScheduled'
  );
};

const scheduleFallbackDisconnect = ({
  userId,
  channelId,
  wsCloseCode,
  finalize,
  fallbackTtlMs
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
      fallback: true
    },
    'missingClientInstanceId'
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
      fallback: true
    },
    'graceScheduled'
  );

  const scheduledAt = Date.now();
  const timer = setTimeout(() => {
    fallbackVoiceDisconnectTimers.delete(timer);
    incrementCounter('graceExpired');

    logVoiceDisconnectEvent(
      'info',
      'grace_expired',
      {
        userId,
        activeChannelId: channelId,
        graceAgeMs: Date.now() - scheduledAt,
        ttlRemainingMs: 0,
        wsCloseCode,
        fallback: true
      },
      'graceExpired'
    );

    finalize();
  }, fallbackTtlMs);

  fallbackVoiceDisconnectTimers.add(timer);
};

const schedulePendingVoiceDisconnect = ({
  clientInstanceId,
  userId,
  channelId,
  wsCloseCode,
  finalize,
  ttlMs = VOICE_DISCONNECT_GRACE_MS,
  fallbackTtlMs = FALLBACK_VOICE_DISCONNECT_GRACE_MS
}: TSchedulePendingVoiceDisconnectOptions) => {
  if (!clientInstanceId) {
    scheduleFallbackDisconnect({
      userId,
      channelId,
      wsCloseCode,
      finalize,
      fallbackTtlMs
    });
    return;
  }

  scheduleTrackedDisconnect({
    clientInstanceId,
    userId,
    channelId,
    wsCloseCode,
    finalize,
    ttlMs
  });
};

const getVoiceDisconnectGraceCounters = () => ({
  ...voiceDisconnectCounters
});

const resetVoiceDisconnectGraceForTests = () => {
  pendingVoiceDisconnects.forEach((pendingDisconnect) => {
    clearTimeout(pendingDisconnect.timer);
  });

  pendingVoiceDisconnects.clear();
  fallbackVoiceDisconnectTimers.forEach((timer) => {
    clearTimeout(timer);
  });
  fallbackVoiceDisconnectTimers.clear();

  voiceDisconnectCounterKeys.forEach((key) => {
    voiceDisconnectCounters[key] = 0;
  });
};

export {
  clearPendingVoiceDisconnect,
  FALLBACK_VOICE_DISCONNECT_GRACE_MS,
  getPendingVoiceReconnectChannelId,
  getPendingVoiceReconnectChannelIdsOwnedElsewhere,
  getVoiceDisconnectGraceCounters,
  resetVoiceDisconnectGraceForTests,
  schedulePendingVoiceDisconnect,
  VOICE_DISCONNECT_GRACE_MS
};
