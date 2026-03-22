import type { TJoinedMessage } from '@sharkord/shared';
import type { IServerState } from './server-store';

const DEFAULT_ARRAY: TJoinedMessage[] = [];

export const messagesMapSelector = (state: IServerState) => state.messagesMap;

export const typingMapSelector = (state: IServerState) => state.typingMap;

export const messagesByChannelIdSelector = (state: IServerState, channelId: number) =>
	state.messagesMap[channelId] || DEFAULT_ARRAY;
