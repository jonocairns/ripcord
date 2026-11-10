import { ServerEvents } from '@sharkord/shared';
import { VoiceRuntime } from '../runtimes/voice';
import { pubsub } from './pubsub';

export const publishVoiceChannelSnapshot = (channelId: number, userIds: number[]): void => {
	const runtime = VoiceRuntime.findById(channelId);
	if (!runtime) return;
	const { users, externalStreams } = runtime.getState();
	for (const userId of userIds) {
		// Current members already hold live state; replay could overwrite local intent.
		if (runtime.getUser(userId)) continue;
		for (const user of users) {
			pubsub.publishFor(userId, ServerEvents.USER_JOIN_VOICE, {
				channelId,
				userId: user.userId,
				state: user.state,
				reconnecting: true,
			});
		}
		for (const [streamId, stream] of Object.entries(externalStreams)) {
			pubsub.publishFor(userId, ServerEvents.VOICE_ADD_EXTERNAL_STREAM, {
				channelId,
				streamId: Number(streamId),
				stream,
			});
		}
	}
};

export const publishVoiceChannelWithdrawal = (channelId: number, userIds: number[]): void => {
	const runtime = VoiceRuntime.findById(channelId);
	if (!runtime) return;
	const { users, externalStreams } = runtime.getState();
	for (const userId of userIds) {
		for (const user of users) {
			// Self leaves terminate the client's call and belong to eviction, not convergence.
			if (user.userId === userId) continue;
			pubsub.publishFor(userId, ServerEvents.USER_LEAVE_VOICE, {
				channelId,
				userId: user.userId,
				reconnecting: true,
			});
		}
		for (const streamId of Object.keys(externalStreams)) {
			pubsub.publishFor(userId, ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM, { channelId, streamId: Number(streamId) });
		}
	}
};
