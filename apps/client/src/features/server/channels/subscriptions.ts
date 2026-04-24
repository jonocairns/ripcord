import { getTRPCClient } from '@/lib/trpc';
import { bufferReconnectSnapshotEvent } from '../reconnect-event-buffer';
import { addChannel, removeChannel, setChannelPermissions, setChannelReadState, updateChannel } from './actions';

const subscribeToChannels = () => {
	const trpc = getTRPCClient();

	const onChannelCreateSub = trpc.channels.onCreate.subscribe(undefined, {
		onData: (channel) => {
			const apply = () => {
				addChannel(channel);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onChannelCreate subscription error:', err),
	});

	const onChannelDeleteSub = trpc.channels.onDelete.subscribe(undefined, {
		onData: (channelId) => {
			const apply = () => {
				removeChannel(channelId);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onChannelDelete subscription error:', err),
	});

	const onChannelUpdateSub = trpc.channels.onUpdate.subscribe(undefined, {
		onData: (channel) => {
			const apply = () => {
				updateChannel(channel.id, channel);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onChannelUpdate subscription error:', err),
	});

	const onChannelPermissionsUpdateSub = trpc.channels.onPermissionsUpdate.subscribe(undefined, {
		onData: (data) => {
			const apply = () => {
				setChannelPermissions(data);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onChannelPermissionsUpdate subscription error:', err),
	});

	const onChannelReadStatesUpdateSub = trpc.channels.onReadStateUpdate.subscribe(undefined, {
		onData: (data) => {
			const apply = () => {
				setChannelReadState(data.channelId, data);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onChannelReadStatesUpdate subscription error:', err),
	});

	const onChannelReadStatesDeltaSub = trpc.channels.onReadStateDelta.subscribe(undefined, {
		onData: (data) => {
			const apply = () => {
				setChannelReadState(data.channelId, data);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onChannelReadStatesDelta subscription error:', err),
	});

	return () => {
		onChannelCreateSub.unsubscribe();
		onChannelDeleteSub.unsubscribe();
		onChannelUpdateSub.unsubscribe();
		onChannelPermissionsUpdateSub.unsubscribe();
		onChannelReadStatesUpdateSub.unsubscribe();
		onChannelReadStatesDeltaSub.unsubscribe();
	};
};

export { subscribeToChannels };
