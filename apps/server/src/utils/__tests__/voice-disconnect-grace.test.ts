import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearPendingVoiceDisconnect,
  getPendingVoiceReconnectChannelId,
  getVoiceDisconnectGraceCounters,
  resetVoiceDisconnectGraceForTests,
  schedulePendingVoiceDisconnect
} from '../voice-disconnect-grace';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

afterEach(() => {
  resetVoiceDisconnectGraceForTests();
});

describe('voice disconnect grace', () => {
  test('cancels only the matching clientInstanceId grace entry', async () => {
    const finalized: string[] = [];

    schedulePendingVoiceDisconnect({
      clientInstanceId: 'client-a',
      userId: 7,
      channelId: 2,
      finalize: () => {
        finalized.push('client-a');
      },
      ttlMs: 15
    });

    schedulePendingVoiceDisconnect({
      clientInstanceId: 'client-b',
      userId: 7,
      channelId: 2,
      finalize: () => {
        finalized.push('client-b');
      },
      ttlMs: 15
    });

    expect(getPendingVoiceReconnectChannelId('client-a', 7)).toBe(2);
    expect(getPendingVoiceReconnectChannelId('client-b', 7)).toBe(2);

    expect(clearPendingVoiceDisconnect('client-a', 7)).toBe(true);
    expect(getPendingVoiceReconnectChannelId('client-a', 7)).toBeUndefined();
    expect(getPendingVoiceReconnectChannelId('client-b', 7)).toBe(2);

    await sleep(30);

    expect(finalized).toEqual(['client-b']);
    expect(getVoiceDisconnectGraceCounters()).toEqual({
      graceScheduled: 2,
      graceCancelled: 1,
      graceExpired: 1,
      missingClientInstanceId: 0
    });
  });

  test('does not expose pending reconnect state to the wrong user', () => {
    schedulePendingVoiceDisconnect({
      clientInstanceId: 'client-a',
      userId: 7,
      channelId: 2,
      finalize: () => {},
      ttlMs: 100
    });

    expect(getPendingVoiceReconnectChannelId('client-a', 7)).toBe(2);
    expect(getPendingVoiceReconnectChannelId('client-a', 8)).toBeUndefined();
  });

  test('does not let one user cancel another user with the same clientInstanceId', async () => {
    const finalized: string[] = [];

    schedulePendingVoiceDisconnect({
      clientInstanceId: 'shared-client',
      userId: 7,
      channelId: 2,
      finalize: () => {
        finalized.push('user-7');
      },
      ttlMs: 15
    });

    schedulePendingVoiceDisconnect({
      clientInstanceId: 'shared-client',
      userId: 8,
      channelId: 3,
      finalize: () => {
        finalized.push('user-8');
      },
      ttlMs: 15
    });

    expect(getPendingVoiceReconnectChannelId('shared-client', 7)).toBe(2);
    expect(getPendingVoiceReconnectChannelId('shared-client', 8)).toBe(3);

    expect(clearPendingVoiceDisconnect('shared-client', 8)).toBe(true);
    expect(getPendingVoiceReconnectChannelId('shared-client', 7)).toBe(2);
    expect(
      getPendingVoiceReconnectChannelId('shared-client', 8)
    ).toBeUndefined();

    await sleep(30);

    expect(finalized).toEqual(['user-7']);
  });

  test('falls back to a short uncancellable grace when clientInstanceId is missing', async () => {
    let finalized = 0;

    schedulePendingVoiceDisconnect({
      userId: 7,
      channelId: 2,
      finalize: () => {
        finalized += 1;
      },
      fallbackTtlMs: 15
    });

    expect(getPendingVoiceReconnectChannelId(undefined, 7)).toBeUndefined();
    expect(clearPendingVoiceDisconnect(undefined)).toBe(false);

    await sleep(30);

    expect(finalized).toBe(1);
    expect(getVoiceDisconnectGraceCounters()).toEqual({
      graceScheduled: 1,
      graceCancelled: 0,
      graceExpired: 1,
      missingClientInstanceId: 1
    });
  });
});
