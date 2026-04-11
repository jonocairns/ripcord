import { ServerEvents, StreamKind } from '@sharkord/shared';
import { describe, expect, test } from 'bun:test';
import { PubSub } from '../pubsub';

describe('pubsub', () => {
  test('filters channel deliveries when the subscriber no longer qualifies', () => {
    const pubsub = new PubSub();
    const receivedRemoteIds: number[] = [];
    let canReceive = true;

    const subscription = pubsub
      .subscribeForChannel(7, ServerEvents.VOICE_NEW_PRODUCER, () => canReceive)
      .subscribe({
        next: (event) => {
          receivedRemoteIds.push(event.remoteId);
        }
      });

    pubsub.publishForChannel(7, ServerEvents.VOICE_NEW_PRODUCER, {
      channelId: 7,
      remoteId: 11,
      kind: StreamKind.AUDIO
    });

    canReceive = false;

    pubsub.publishForChannel(7, ServerEvents.VOICE_NEW_PRODUCER, {
      channelId: 7,
      remoteId: 12,
      kind: StreamKind.VIDEO
    });

    canReceive = true;

    pubsub.publishForChannel(7, ServerEvents.VOICE_NEW_PRODUCER, {
      channelId: 7,
      remoteId: 13,
      kind: StreamKind.SCREEN
    });

    expect(receivedRemoteIds).toEqual([11, 13]);

    subscription.unsubscribe();
  });
});
