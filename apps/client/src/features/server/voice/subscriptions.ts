import { getTRPCClient } from '@/lib/trpc';
import { bufferReconnectSnapshotEvent } from '../reconnect-event-buffer';
import {
	addExternalStreamToVoiceChannel,
	addUserToVoiceChannel,
	handleStreamWatcherActivity,
	handleVoiceSessionReplaced,
	removeExternalStreamFromVoiceChannel,
	removeUserFromVoiceChannel,
	updateExternalStreamInVoiceChannel,
	updateVoiceUserState,
} from './actions';

const subscribeToVoice = () => {
	const trpc = getTRPCClient();

	const onUserJoinVoiceSub = trpc.voice.onJoin.subscribe(undefined, {
		onData: ({ channelId, userId, state, reconnecting }) => {
			const apply = () => {
				addUserToVoiceChannel(userId, channelId, state, { reconnecting });
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onUserJoinVoice subscription error:', err),
	});

	const onUserLeaveVoiceSub = trpc.voice.onLeave.subscribe(undefined, {
		onData: ({ channelId, userId, reconnecting }) => {
			const apply = () => {
				removeUserFromVoiceChannel(userId, channelId, { reconnecting });
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onUserLeaveVoice subscription error:', err),
	});

	const onUserUpdateVoiceSub = trpc.voice.onUpdateState.subscribe(undefined, {
		onData: ({ channelId, userId, state }) => {
			const apply = () => {
				updateVoiceUserState(userId, channelId, state);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onUserUpdateVoice subscription error:', err),
	});

	const onVoiceAddExternalStreamSub = trpc.voice.onAddExternalStream.subscribe(undefined, {
		onData: ({ channelId, streamId, stream }) => {
			const apply = () => {
				addExternalStreamToVoiceChannel(channelId, streamId, stream);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onVoiceAddExternalStreamSub subscription error:', err),
	});

	const onVoiceUpdateExternalStreamSub = trpc.voice.onUpdateExternalStream.subscribe(undefined, {
		onData: ({ channelId, streamId, stream }) => {
			const apply = () => {
				updateExternalStreamInVoiceChannel(channelId, streamId, stream);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onVoiceUpdateExternalStreamSub subscription error:', err),
	});

	const onVoiceRemoveExternalStreamSub = trpc.voice.onRemoveExternalStream.subscribe(undefined, {
		onData: ({ channelId, streamId }) => {
			const apply = () => {
				removeExternalStreamFromVoiceChannel(channelId, streamId);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onVoiceRemoveExternalStreamSub subscription error:', err),
	});

	const onVoiceStreamWatcherActivitySub = trpc.voice.onStreamWatcherActivity.subscribe(undefined, {
		onData: (activity) => {
			const apply = () => {
				handleStreamWatcherActivity(activity);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onVoiceStreamWatcherActivitySub subscription error:', err),
	});

	const onVoiceSessionReplacedSub = trpc.voice.onSessionReplaced.subscribe(undefined, {
		onData: () => {
			const apply = () => {
				handleVoiceSessionReplaced();
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onVoiceSessionReplaced subscription error:', err),
	});

	return () => {
		onUserJoinVoiceSub.unsubscribe();
		onUserLeaveVoiceSub.unsubscribe();
		onUserUpdateVoiceSub.unsubscribe();
		onVoiceAddExternalStreamSub.unsubscribe();
		onVoiceUpdateExternalStreamSub.unsubscribe();
		onVoiceRemoveExternalStreamSub.unsubscribe();
		onVoiceStreamWatcherActivitySub.unsubscribe();
		onVoiceSessionReplacedSub.unsubscribe();
	};
};

export { subscribeToVoice };
