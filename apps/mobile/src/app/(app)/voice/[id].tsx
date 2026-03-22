import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useServerStore } from '@sharkord/app-core';
import { currentVoiceChannelIdSelector, ownVoiceStateSelector, userByIdSelector } from '@sharkord/app-core';
import { useMobileVoice } from '@/components/mobile-voice-provider';

export default function VoiceChannelScreen() {
	const params = useLocalSearchParams<{ id: string }>();
	const channelId = Number(params.id);
	const channel = useServerStore((state) => state.channels.find((entry) => entry.id === channelId));
	const currentVoiceChannelId = useServerStore(currentVoiceChannelIdSelector);
	const ownVoiceState = useServerStore(ownVoiceStateSelector);
	const voiceChannelState = useServerStore((state) => state.voiceMap[channelId]);
	const { connectionStatus, errorMessage, isBusy, joinChannel, leaveChannel, setMicMuted, setSoundMuted } =
		useMobileVoice();
	const isActiveChannel = currentVoiceChannelId === channelId;

	useEffect(() => {
		if (!channelId || Number.isNaN(channelId) || currentVoiceChannelId === channelId) {
			return;
		}

		void joinChannel(channelId);
	}, [channelId, currentVoiceChannelId, joinChannel]);

	const voiceUsers = useMemo(() => {
		const entries = Object.entries(voiceChannelState?.users ?? {});

		return entries.map(([userId, state]) => ({
			state,
			user: userByIdSelector(useServerStore.getState(), Number(userId)),
		}));
	}, [voiceChannelState]);

	return (
		<ScrollView style={{ backgroundColor: '#08121c', flex: 1 }} contentContainerStyle={{ gap: 18, padding: 20 }}>
			<View style={{ gap: 6 }}>
				<Text style={{ color: '#f4fbff', fontSize: 28, fontWeight: '700' }}>{channel?.name ?? 'Voice'}</Text>
				<Text style={{ color: '#9dc3d8' }}>
					{connectionStatus === 'connecting' || connectionStatus === 'reconnecting'
						? 'Joining voice…'
						: connectionStatus === 'connected'
							? 'Mobile voice audio transport is active.'
							: 'Voice transport is idle.'}
				</Text>
				{errorMessage ? <Text style={{ color: '#ffb7b7' }}>{errorMessage}</Text> : null}
			</View>

			<View style={{ flexDirection: 'row', gap: 12 }}>
				<Pressable
					onPress={() => void setMicMuted(!ownVoiceState.micMuted)}
					style={{
						alignItems: 'center',
						backgroundColor: ownVoiceState.micMuted ? '#7d2424' : '#102233',
						borderRadius: 12,
						flex: 1,
						opacity: isBusy ? 0.6 : 1,
						paddingVertical: 14,
					}}
				>
					<Text style={{ color: '#f4fbff', fontWeight: '700' }}>
						{ownVoiceState.micMuted ? 'Unmute Mic' : 'Mute Mic'}
					</Text>
				</Pressable>
				<Pressable
					onPress={() => void setSoundMuted(!ownVoiceState.soundMuted)}
					style={{
						alignItems: 'center',
						backgroundColor: ownVoiceState.soundMuted ? '#7d2424' : '#102233',
						borderRadius: 12,
						flex: 1,
						opacity: isBusy ? 0.6 : 1,
						paddingVertical: 14,
					}}
				>
					<Text style={{ color: '#f4fbff', fontWeight: '700' }}>
						{ownVoiceState.soundMuted ? 'Undeafen' : 'Deafen'}
					</Text>
				</Pressable>
			</View>

			<Pressable
				onPress={() => {
					if (isActiveChannel) {
						void leaveChannel();
						return;
					}

					void joinChannel(channelId);
				}}
				style={{
					alignItems: 'center',
					backgroundColor: '#0e2b3e',
					borderRadius: 12,
					opacity: isBusy ? 0.6 : 1,
					paddingVertical: 14,
				}}
			>
				<Text style={{ color: '#d7edf9', fontWeight: '700' }}>
					{isActiveChannel ? 'Leave Channel' : connectionStatus === 'failed' ? 'Retry Join' : 'Join Channel'}
				</Text>
			</Pressable>

			<View style={{ gap: 10 }}>
				<Text style={{ color: '#72d7ff', fontSize: 13, fontWeight: '700', textTransform: 'uppercase' }}>
					Participants
				</Text>
				{voiceUsers.map(({ state, user }) => (
					<View
						key={String(user?.id ?? 'unknown-user')}
						style={{
							backgroundColor: '#102233',
							borderColor: '#1b3d56',
							borderRadius: 14,
							borderWidth: 1,
							gap: 4,
							padding: 16,
						}}
					>
						<Text style={{ color: '#f4fbff', fontSize: 16, fontWeight: '600' }}>{user?.name ?? 'Unknown user'}</Text>
						<Text style={{ color: '#8eb0c6' }}>
							{state.micMuted ? 'Muted' : 'Speaking enabled'} · {state.soundMuted ? 'Deafened' : 'Listening'}
						</Text>
					</View>
				))}
			</View>
		</ScrollView>
	);
}
