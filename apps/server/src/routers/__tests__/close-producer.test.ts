/**
 * Integration tests for the voice.closeProducer producerId guard.
 *
 * The guard allows the client to supply the ID of the producer it believes
 * is active. If the IDs do not match (e.g. a stale close message arrives
 * after a transport rebuild already replaced the producer) the route must
 * return without touching the runtime — preventing a race condition where
 * the freshly-rebuilt producer gets torn down by a delayed message.
 */

import { StreamKind } from '@sharkord/shared';
import { afterEach, describe, expect, test } from 'bun:test';
import type { AppData, Producer } from 'mediasoup/types';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken } from '../../__tests__/helpers';
import { appRouter } from '../../routers';
import { VoiceRuntime } from '../../runtimes/voice';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_BASE = 92_000;
let channelCounter = 0;
const nextChannelId = () => CHANNEL_BASE + ++channelCounter;

/**
 * Minimal producer stub — only the surface area that VoiceRuntime.addProducer
 * and removeProducer actually touch.
 */
const makeMockProducer = (id: string): Producer<AppData> => {
  let closeHandler: (() => void) | undefined;
  let closed = false;

  return {
    id,
    get closed() {
      return closed;
    },
    observer: {
      on: (_event: string, handler: () => void) => {
        closeHandler = handler;
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      closeHandler?.();
    }
  } as unknown as Producer<AppData>;
};

/**
 * Creates an authenticated TRPC caller and the underlying mutable context.
 * Setting ctx.currentVoiceChannelId after construction is intentional —
 * it simulates the state that voice.join would normally establish.
 */
const makeContext = async () => {
  const mockedToken = await getMockedToken(1);
  const ctx = await createMockContext({ customToken: mockedToken });
  const caller = appRouter.createCaller(ctx);

  const { handshakeHash } = await caller.others.handshake();
  await caller.others.joinServer({ handshakeHash });

  return { ctx, caller };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('voice.closeProducer producerId guard', () => {
  const runtimes: VoiceRuntime[] = [];

  afterEach(async () => {
    for (const runtime of runtimes) {
      try {
        await runtime.destroy();
      } catch {
        // ignore — runtime may already be torn down
      }
    }
    runtimes.length = 0;
  });

  const makeRuntime = async (): Promise<VoiceRuntime> => {
    const runtime = new VoiceRuntime(nextChannelId());
    runtimes.push(runtime);
    await runtime.init();
    return runtime;
  };

  test('throws BAD_REQUEST when user is not in a voice channel', async () => {
    const { caller } = await makeContext();

    await expect(
      caller.voice.closeProducer({ kind: StreamKind.AUDIO })
    ).rejects.toThrow('User is not in a voice channel');
  });

  test('returns without error when there is no producer of that kind', async () => {
    const { ctx, caller } = await makeContext();
    const runtime = await makeRuntime();

    runtime.addUser(ctx.user.id, { micMuted: false, soundMuted: false });
    ctx.currentVoiceChannelId = runtime.id;

    await expect(
      caller.voice.closeProducer({ kind: StreamKind.AUDIO })
    ).resolves.toBeUndefined();
  });

  test('is a no-op when producerId does not match the active producer', async () => {
    const { ctx, caller } = await makeContext();
    const runtime = await makeRuntime();

    runtime.addUser(ctx.user.id, { micMuted: false, soundMuted: false });
    ctx.currentVoiceChannelId = runtime.id;

    const mockProducer = makeMockProducer('current-id');
    runtime.addProducer(ctx.user.id, StreamKind.AUDIO, mockProducer);

    await caller.voice.closeProducer({
      kind: StreamKind.AUDIO,
      producerId: 'stale-id'
    });

    // Producer must still be present — the stale close must not evict it.
    expect(runtime.getProducer(StreamKind.AUDIO, ctx.user.id)).toBe(
      mockProducer
    );
    expect(mockProducer.closed).toBe(false);
  });

  test('removes the producer when producerId matches', async () => {
    const { ctx, caller } = await makeContext();
    const runtime = await makeRuntime();

    runtime.addUser(ctx.user.id, { micMuted: false, soundMuted: false });
    ctx.currentVoiceChannelId = runtime.id;

    const mockProducer = makeMockProducer('correct-id');
    runtime.addProducer(ctx.user.id, StreamKind.AUDIO, mockProducer);

    await caller.voice.closeProducer({
      kind: StreamKind.AUDIO,
      producerId: 'correct-id'
    });

    expect(runtime.getProducer(StreamKind.AUDIO, ctx.user.id)).toBeUndefined();
    expect(mockProducer.closed).toBe(true);
  });
});
