import { ChannelType, ServerEvents } from '@sharkord/shared';
import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken, initTest } from '../../__tests__/helpers';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { appRouter } from '../../routers';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';
import {
  resetVoiceDisconnectGraceForTests,
  schedulePendingVoiceDisconnect
} from '../../utils/voice-disconnect-grace';
import {
  VOICE_SESSION_OWNED_ELSEWHERE,
  VOICE_SESSION_WRONG_CHANNEL
} from '../voice/restore-or-join';

const PRIMARY_VOICE_CHANNEL_ID = 2;
const SECONDARY_VOICE_CHANNEL_ID = 3;

const ensureVoiceRuntime = async (
  channelId: number,
  channelName: string
): Promise<VoiceRuntime> => {
  const existingRuntime = VoiceRuntime.findById(channelId);

  if (existingRuntime) {
    return existingRuntime;
  }

  const existingChannel = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .get();

  if (!existingChannel) {
    await db.insert(channels).values({
      id: channelId,
      type: ChannelType.VOICE,
      name: channelName,
      topic: `${channelName} topic`,
      fileAccessToken: crypto.randomUUID(),
      fileAccessTokenUpdatedAt: Date.now(),
      position: channelId - 1,
      categoryId: 2,
      createdAt: Date.now()
    });
  }

  const runtime = new VoiceRuntime(channelId);
  await runtime.init();

  return runtime;
};

const clearVoiceRuntime = async (channelId: number) => {
  const runtime = VoiceRuntime.findById(channelId);

  if (!runtime) {
    return;
  }

  [...runtime.getState().users].forEach((user) => {
    runtime.removeUser(user.userId);
  });

  await runtime.destroy();
};

const attachTrackedSession = (
  ctx: Awaited<ReturnType<typeof createMockContext>>,
  session: {
    clientInstanceId: string;
    currentVoiceChannelId: number | undefined;
  },
  allSessions: Array<{
    clientInstanceId: string;
    currentVoiceChannelId: number | undefined;
  }>
) => {
  Reflect.set(ctx, 'getOwnWs', () => session);
  Reflect.set(ctx, 'getUserWss', () => allSessions);
  Reflect.set(ctx, 'setWsVoiceChannelId', (channelId: number | undefined) => {
    session.currentVoiceChannelId = channelId;
    ctx.currentVoiceChannelId = channelId;
  });
};

afterEach(async () => {
  await clearVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID);
  await clearVoiceRuntime(SECONDARY_VOICE_CHANNEL_ID);
  resetVoiceDisconnectGraceForTests();
});

describe('voice.restoreOrJoin', () => {
  test('joins normally and returns bootstrap when the user is not already in voice', async () => {
    await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

    const joinEvents: Array<{ channelId: number; userId: number }> = [];
    const sessionReplacedEvents: number[] = [];
    const joinSub = pubsub.subscribe(ServerEvents.USER_JOIN_VOICE).subscribe({
      next: (event) => {
        joinEvents.push({
          channelId: event.channelId,
          userId: event.userId
        });
      }
    });
    const replacedSub = pubsub
      .subscribeFor(1, ServerEvents.VOICE_SESSION_REPLACED)
      .subscribe({
        next: (event) => {
          sessionReplacedEvents.push(event.channelId);
        }
      });

    try {
      const { caller } = await initTest(1);

      const result = await caller.voice.restoreOrJoin({
        channelId: PRIMARY_VOICE_CHANNEL_ID,
        state: {
          micMuted: true,
          soundMuted: false
        },
        reconnectAttemptId: 'attempt-0'
      });

      expect(result.channelUsers).toContainEqual({
        userId: 1,
        state: {
          micMuted: true,
          soundMuted: false,
          webcamEnabled: false,
          sharingScreen: false
        }
      });
      expect(
        VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUserState(1)
      ).toEqual({
        micMuted: true,
        soundMuted: false,
        webcamEnabled: false,
        sharingScreen: false
      });
      expect(joinEvents).toEqual([
        {
          channelId: PRIMARY_VOICE_CHANNEL_ID,
          userId: 1
        }
      ]);
      expect(sessionReplacedEvents).toEqual([]);
    } finally {
      joinSub.unsubscribe();
      replacedSub.unsubscribe();
    }
  });

  test('returns bootstrap without join, leave, or session-replaced side effects for the same session', async () => {
    await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

    const joinEvents: number[] = [];
    const leaveEvents: number[] = [];
    const sessionReplacedEvents: number[] = [];
    const joinSub = pubsub.subscribe(ServerEvents.USER_JOIN_VOICE).subscribe({
      next: (event) => {
        joinEvents.push(event.channelId);
      }
    });
    const leaveSub = pubsub.subscribe(ServerEvents.USER_LEAVE_VOICE).subscribe({
      next: (event) => {
        leaveEvents.push(event.channelId);
      }
    });
    const replacedSub = pubsub
      .subscribeFor(1, ServerEvents.VOICE_SESSION_REPLACED)
      .subscribe({
        next: (event) => {
          sessionReplacedEvents.push(event.channelId);
        }
      });

    try {
      const { caller } = await initTest(1);

      await caller.voice.join({
        channelId: PRIMARY_VOICE_CHANNEL_ID,
        state: {
          micMuted: false,
          soundMuted: false
        }
      });

      joinEvents.length = 0;
      leaveEvents.length = 0;
      sessionReplacedEvents.length = 0;

      const result = await caller.voice.restoreOrJoin({
        channelId: PRIMARY_VOICE_CHANNEL_ID,
        state: {
          micMuted: false,
          soundMuted: false
        },
        reconnectAttemptId: 'attempt-1'
      });

      expect(result.channelUsers.some((user) => user.userId === 1)).toBe(true);
      expect(joinEvents).toEqual([]);
      expect(leaveEvents).toEqual([]);
      expect(sessionReplacedEvents).toEqual([]);
    } finally {
      joinSub.unsubscribe();
      leaveSub.unsubscribe();
      replacedSub.unsubscribe();
    }
  });

  test('forced reconnect-lab restore failures are one-shot', async () => {
    await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

    const { caller } = await initTest(1);

    await caller.voice.join({
      channelId: PRIMARY_VOICE_CHANNEL_ID,
      state: {
        micMuted: false,
        soundMuted: false
      }
    });

    await caller.voice.reconnectLab.setNextRestoreBehavior({
      failMessage: 'VOICE_RECONNECT_LAB_FORCED_FAILURE'
    });

    await expect(
      caller.voice.restoreOrJoin({
        channelId: PRIMARY_VOICE_CHANNEL_ID,
        state: {
          micMuted: false,
          soundMuted: false
        },
        reconnectAttemptId: 'attempt-restore-lab-fail'
      })
    ).rejects.toThrow('VOICE_RECONNECT_LAB_FORCED_FAILURE');

    const result = await caller.voice.restoreOrJoin({
      channelId: PRIMARY_VOICE_CHANNEL_ID,
      state: {
        micMuted: false,
        soundMuted: false
      },
      reconnectAttemptId: 'attempt-restore-lab-retry'
    });

    expect(result.channelUsers.some((user) => user.userId === 1)).toBe(true);
  });

  test('forgetOwnVoiceSession drops the server-side voice session and broadcasts a reconnecting leave', async () => {
    await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

    const leaveEvents: {
      channelId: number;
      userId: number;
      reconnecting?: boolean;
    }[] = [];
    const leaveSub = pubsub.subscribe(ServerEvents.USER_LEAVE_VOICE).subscribe({
      next: (event) => {
        leaveEvents.push(event);
      }
    });

    try {
      const { caller } = await initTest(1);

      await caller.voice.join({
        channelId: PRIMARY_VOICE_CHANNEL_ID,
        state: {
          micMuted: false,
          soundMuted: false
        }
      });

      leaveEvents.length = 0;

      const result = await caller.voice.reconnectLab.forgetOwnVoiceSession();

      expect(result).toEqual({
        forgotten: true,
        channelId: PRIMARY_VOICE_CHANNEL_ID
      });
      expect(
        VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)
      ).toBeUndefined();
      expect(leaveEvents).toEqual([
        {
          channelId: PRIMARY_VOICE_CHANNEL_ID,
          userId: 1,
          reconnecting: true
        }
      ]);
    } finally {
      leaveSub.unsubscribe();
    }
  });

  test('returns CONFLICT when the active voice session is in a different channel', async () => {
    await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');
    await ensureVoiceRuntime(SECONDARY_VOICE_CHANNEL_ID, 'Voice 2');

    const { caller } = await initTest(1);

    await caller.voice.join({
      channelId: PRIMARY_VOICE_CHANNEL_ID,
      state: {
        micMuted: false,
        soundMuted: false
      }
    });

    await expect(
      caller.voice.restoreOrJoin({
        channelId: SECONDARY_VOICE_CHANNEL_ID,
        state: {
          micMuted: false,
          soundMuted: false
        },
        reconnectAttemptId: 'attempt-2'
      })
    ).rejects.toThrow(VOICE_SESSION_WRONG_CHANNEL);

    expect(
      VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)
    ).toBeDefined();
    expect(
      VoiceRuntime.findById(SECONDARY_VOICE_CHANNEL_ID)?.getUser(1)
    ).toBeUndefined();
  });

  test('allows restore when another open socket belongs to the same client instance', async () => {
    await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

    const mockedToken = await getMockedToken(1);
    const ctxA = await createMockContext({
      customToken: mockedToken
    });
    const ctxB = await createMockContext({
      customToken: mockedToken
    });
    const sessionA = {
      clientInstanceId: 'shared-client',
      currentVoiceChannelId: undefined as number | undefined
    };
    const sessionB = {
      clientInstanceId: 'shared-client',
      currentVoiceChannelId: undefined as number | undefined
    };
    const trackedSessions = [sessionA, sessionB];

    attachTrackedSession(ctxA, sessionA, trackedSessions);
    attachTrackedSession(ctxB, sessionB, trackedSessions);

    const sessionReplacedEvents: number[] = [];
    const replacedSub = pubsub
      .subscribeFor(1, ServerEvents.VOICE_SESSION_REPLACED)
      .subscribe({
        next: (event) => {
          sessionReplacedEvents.push(event.channelId);
        }
      });

    try {
      const callerA = appRouter.createCaller(ctxA);
      const callerB = appRouter.createCaller(ctxB);
      const handshakeA = await callerA.others.handshake();
      const handshakeB = await callerB.others.handshake();

      await callerA.others.joinServer({
        handshakeHash: handshakeA.handshakeHash
      });
      await callerB.others.joinServer({
        handshakeHash: handshakeB.handshakeHash
      });

      await callerA.voice.join({
        channelId: PRIMARY_VOICE_CHANNEL_ID,
        state: {
          micMuted: false,
          soundMuted: false
        }
      });

      const result = await callerB.voice.restoreOrJoin({
        channelId: PRIMARY_VOICE_CHANNEL_ID,
        state: {
          micMuted: false,
          soundMuted: false
        },
        reconnectAttemptId: 'attempt-same-client-overlap'
      });

      expect(result.channelUsers.some((user) => user.userId === 1)).toBe(true);
      expect(sessionA.currentVoiceChannelId).toBe(PRIMARY_VOICE_CHANNEL_ID);
      expect(sessionB.currentVoiceChannelId).toBe(PRIMARY_VOICE_CHANNEL_ID);
      expect(sessionReplacedEvents).toEqual([]);
    } finally {
      replacedSub.unsubscribe();
    }
  });

  test('returns CONFLICT without eviction when another active session owns the requested channel', async () => {
    await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

    const mockedToken = await getMockedToken(1);
    const ctxA = await createMockContext({
      customToken: mockedToken
    });
    const ctxB = await createMockContext({
      customToken: mockedToken
    });
    const sessionA = {
      clientInstanceId: 'session-a',
      currentVoiceChannelId: undefined as number | undefined
    };
    const sessionB = {
      clientInstanceId: 'session-b',
      currentVoiceChannelId: undefined as number | undefined
    };
    const trackedSessions = [sessionA, sessionB];

    attachTrackedSession(ctxA, sessionA, trackedSessions);
    attachTrackedSession(ctxB, sessionB, trackedSessions);

    const sessionReplacedEvents: number[] = [];
    const replacedSub = pubsub
      .subscribeFor(1, ServerEvents.VOICE_SESSION_REPLACED)
      .subscribe({
        next: (event) => {
          sessionReplacedEvents.push(event.channelId);
        }
      });

    try {
      const callerA = appRouter.createCaller(ctxA);
      const callerB = appRouter.createCaller(ctxB);
      const handshakeA = await callerA.others.handshake();
      const handshakeB = await callerB.others.handshake();

      await callerA.others.joinServer({
        handshakeHash: handshakeA.handshakeHash
      });
      await callerB.others.joinServer({
        handshakeHash: handshakeB.handshakeHash
      });

      await callerA.voice.join({
        channelId: PRIMARY_VOICE_CHANNEL_ID,
        state: {
          micMuted: false,
          soundMuted: false
        }
      });

      expect(sessionA.currentVoiceChannelId).toBe(PRIMARY_VOICE_CHANNEL_ID);

      await expect(
        callerB.voice.restoreOrJoin({
          channelId: PRIMARY_VOICE_CHANNEL_ID,
          state: {
            micMuted: false,
            soundMuted: false
          },
          reconnectAttemptId: 'attempt-3'
        })
      ).rejects.toThrow(VOICE_SESSION_OWNED_ELSEWHERE);

      expect(
        VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)
      ).toBeDefined();
      expect(sessionReplacedEvents).toEqual([]);
    } finally {
      replacedSub.unsubscribe();
    }
  });

  test('returns CONFLICT when another client instance owns the pending reconnect grace for the channel', async () => {
    await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

    const mockedToken = await getMockedToken(1);
    const ctxA = await createMockContext({
      customToken: mockedToken
    });
    const ctxB = await createMockContext({
      customToken: mockedToken
    });
    const sessionA = {
      clientInstanceId: 'session-a',
      currentVoiceChannelId: undefined as number | undefined
    };
    const sessionB = {
      clientInstanceId: 'session-b',
      currentVoiceChannelId: undefined as number | undefined
    };
    const openSessions = [sessionA];

    attachTrackedSession(ctxA, sessionA, openSessions);
    attachTrackedSession(ctxB, sessionB, [sessionB]);

    try {
      const callerA = appRouter.createCaller(ctxA);
      const callerB = appRouter.createCaller(ctxB);
      const handshakeA = await callerA.others.handshake();
      const handshakeB = await callerB.others.handshake();

      await callerA.others.joinServer({
        handshakeHash: handshakeA.handshakeHash
      });
      await callerB.others.joinServer({
        handshakeHash: handshakeB.handshakeHash
      });

      await callerA.voice.join({
        channelId: PRIMARY_VOICE_CHANNEL_ID,
        state: {
          micMuted: false,
          soundMuted: false
        }
      });

      openSessions.length = 0;

      schedulePendingVoiceDisconnect({
        clientInstanceId: sessionA.clientInstanceId,
        userId: 1,
        channelId: PRIMARY_VOICE_CHANNEL_ID,
        finalize: () => {}
      });

      await expect(
        callerB.voice.restoreOrJoin({
          channelId: PRIMARY_VOICE_CHANNEL_ID,
          state: {
            micMuted: false,
            soundMuted: false
          },
          reconnectAttemptId: 'attempt-pending-grace-conflict'
        })
      ).rejects.toThrow(VOICE_SESSION_OWNED_ELSEWHERE);

      expect(
        VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)
      ).toBeDefined();
    } finally {
      openSessions.length = 0;
    }
  });
});
