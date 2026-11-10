import type { ServerEvents } from '@sharkord/shared';
import { getChannelViewerIdsSync } from '../db/queries/channels';
import { type Events, pubsub } from './pubsub';

type VoiceSidebarTopic =
	| ServerEvents.USER_JOIN_VOICE
	| ServerEvents.USER_LEAVE_VOICE
	| ServerEvents.USER_VOICE_STATE_UPDATE
	| ServerEvents.VOICE_ADD_EXTERNAL_STREAM
	| ServerEvents.VOICE_UPDATE_EXTERNAL_STREAM
	| ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM;

export const publishVoiceSidebarEvent = <T extends VoiceSidebarTopic>(topic: T, payload: Events[T]): void => {
	const recipients = new Set(getChannelViewerIdsSync(payload.channelId) ?? []);
	// Subjects must learn about their own eviction even after losing channel access.
	if ('userId' in payload) recipients.add(payload.userId);
	pubsub.publishFor([...recipients], topic, payload);
};
