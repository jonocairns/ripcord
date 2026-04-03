import type { TJoinedMessage } from '@sharkord/shared';
import type { IServerState } from '../slice';

const DEFAULT_ARRAY: TJoinedMessage[] = [];

export const messagesByChannelIdSelector = (state: IServerState, channelId: number) =>
	state.messagesMap[channelId] || DEFAULT_ARRAY;
