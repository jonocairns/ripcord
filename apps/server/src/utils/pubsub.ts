// src/utils/pubsub.ts
import type {
  ServerEvents,
  StreamKind,
  TChannel,
  TJoinedEmoji,
  TJoinedMessage,
  TJoinedPublicUser,
  TJoinedRole,
  TSettings,
  TVoiceUserState
} from '@sharkord/shared';
import type { Unsubscribable } from '@trpc/server/observable';
import { observable, type Observable } from '@trpc/server/observable';
import { EventEmitter } from 'events';

type Events = {
  [ServerEvents.NEW_MESSAGE]: TJoinedMessage;
  [ServerEvents.MESSAGE_UPDATE]: TJoinedMessage;
  [ServerEvents.MESSAGE_DELETE]: {
    messageId: number;
    channelId: number;
  };
  [ServerEvents.MESSAGE_TYPING]: {
    channelId: number;
    userId: number;
  };

  [ServerEvents.USER_JOIN]: TJoinedPublicUser;
  [ServerEvents.USER_LEAVE]: number;
  [ServerEvents.USER_CREATE]: TJoinedPublicUser;
  [ServerEvents.USER_UPDATE]: TJoinedPublicUser;
  [ServerEvents.USER_DELETE]: number;

  [ServerEvents.CHANNEL_CREATE]: TChannel;
  [ServerEvents.CHANNEL_UPDATE]: TChannel;
  [ServerEvents.CHANNEL_DELETE]: number;

  [ServerEvents.USER_JOIN_VOICE]: {
    channelId: number;
    userId: number;
    state: TVoiceUserState;
  };
  [ServerEvents.USER_LEAVE_VOICE]: {
    channelId: number;
    userId: number;
  };
  [ServerEvents.USER_VOICE_STATE_UPDATE]: {
    channelId: number;
    userId: number;
    state: TVoiceUserState;
  };

  [ServerEvents.VOICE_NEW_PRODUCER]: {
    channelId: number;
    remoteUserId: number;
    kind: StreamKind;
  };
  [ServerEvents.VOICE_PRODUCER_CLOSED]: {
    channelId: number;
    remoteUserId: number;
    kind: StreamKind;
  };

  [ServerEvents.EMOJI_CREATE]: TJoinedEmoji;
  [ServerEvents.EMOJI_UPDATE]: TJoinedEmoji;
  [ServerEvents.EMOJI_DELETE]: number;

  [ServerEvents.ROLE_CREATE]: TJoinedRole;
  [ServerEvents.ROLE_UPDATE]: TJoinedRole;
  [ServerEvents.ROLE_DELETE]: number;

  [ServerEvents.SERVER_SETTINGS_UPDATE]: TSettings;
};

class PubSub {
  private ee: EventEmitter;

  constructor() {
    this.ee = new EventEmitter();

    this.ee.setMaxListeners(50);
  }

  public publish<TTopic extends keyof Events>(
    topic: TTopic,
    payload: Events[TTopic]
  ): void {
    this.ee.emit(topic, payload);
  }

  public subscribe<TTopic extends keyof Events>(
    topic: TTopic
  ): Observable<Events[TTopic], unknown> {
    return observable((observer) => {
      const listener = (data: Events[TTopic]) => {
        observer.next(data);
      };

      this.ee.on(topic, listener);

      const ee = this.ee;

      const unsubscribable: Unsubscribable = {
        unsubscribe() {
          ee.off(topic, listener);
        }
      };

      return unsubscribable;
    });
  }
}

export const pubsub = new PubSub();
