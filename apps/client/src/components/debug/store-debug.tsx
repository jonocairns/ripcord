import { useShallow } from 'zustand/react/shallow';
import { useServerStore } from '@/features/server/slice';
import { ownVoiceStateSelector } from '@/features/server/voice/selectors';
import { logDebug } from '@/helpers/browser-logger';

const StoreDebug = () => {
	const server = useServerStore(
		useShallow((state) => ({
			connected: state.connected,
			connecting: state.connecting,
			mustChangePassword: state.mustChangePassword,
			disconnectInfo: state.disconnectInfo,
			serverId: state.serverId,
			categories: state.categories,
			channels: state.channels,
			emojis: state.emojis,
			ownUserId: state.ownUserId,
			selectedChannelId: state.selectedChannelId,
			currentVoiceChannelId: state.currentVoiceChannelId,
			messagesMap: state.messagesMap,
			users: state.users,
			roles: state.roles,
			publicSettings: state.publicSettings,
			info: state.info,
			loadingInfo: state.loadingInfo,
			voiceMap: state.voiceMap,
			externalStreamsMap: state.externalStreamsMap,
			ownVoiceDefaults: state.ownVoiceDefaults,
			ownVoiceState: ownVoiceStateSelector(state),
			pinnedCard: state.pinnedCard,
			channelPermissions: state.channelPermissions,
			readStatesMap: state.readStatesMap,
			pluginCommands: state.pluginCommands,
		})),
	);

	logDebug('Server State', server);

	return null;
};

export { StoreDebug };
