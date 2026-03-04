import { getTRPCClient } from '@/lib/trpc';
import { TYPING_MS, type TJoinedMessage } from '@sharkord/shared';
import { selectedChannelIdSelector } from '../channels/selectors';
import { useServerStore } from '../slice';
import { playSound } from '../sounds/actions';
import { SoundType } from '../types';
import { ownUserIdSelector } from '../users/selectors';

const typingTimeouts: { [key: string]: NodeJS.Timeout } = {};

const getTypingKey = (channelId: number, userId: number) =>
  `${channelId}-${userId}`;

export const addMessages = (
  channelId: number,
  messages: TJoinedMessage[],
  opts: { prepend?: boolean } = {},
  isSubscriptionMessage = false
) => {
  const state = useServerStore.getState();
  const selectedChannelId = selectedChannelIdSelector(state);

  useServerStore.getState().addMessages({ channelId, messages, opts });

  messages.forEach((message) => {
    removeTypingUser(channelId, message.userId);
  });

  if (isSubscriptionMessage && messages.length > 0) {
    const state = useServerStore.getState();
    const ownUserId = ownUserIdSelector(state);
    const targetMessage = messages[0];
    const isFromOwnUser = ownUserId === targetMessage.userId;

    if (!isFromOwnUser) {
      playSound(SoundType.MESSAGE_RECEIVED);
    }

    if (channelId === selectedChannelId && !isFromOwnUser) {
      // user is viewing this channel - mark messages as read
      const trpc = getTRPCClient();

      try {
        trpc.channels.markAsRead.mutate({ channelId });
      } catch {
        // ignore errors
      }
    }
  }
};

export const updateMessage = (channelId: number, message: TJoinedMessage) => {
  useServerStore.getState().updateMessage({ channelId, message });
};

export const deleteMessage = (channelId: number, messageId: number) => {
  useServerStore.getState().deleteMessage({ channelId, messageId });
};

export const addTypingUser = (channelId: number, userId: number) => {
  useServerStore.getState().addTypingUser({ channelId, userId });

  const timeoutKey = getTypingKey(channelId, userId);

  if (typingTimeouts[timeoutKey]) {
    clearTimeout(typingTimeouts[timeoutKey]);
  }

  typingTimeouts[timeoutKey] = setTimeout(() => {
    removeTypingUser(channelId, userId);
    delete typingTimeouts[timeoutKey];
  }, TYPING_MS + 500);
};

export const removeTypingUser = (channelId: number, userId: number) => {
  useServerStore.getState().removeTypingUser({ channelId, userId });
};
