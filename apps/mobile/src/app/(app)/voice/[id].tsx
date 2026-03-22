import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useServerStore } from '@sharkord/app-core';
import { currentVoiceChannelIdSelector, ownVoiceStateSelector, userByIdSelector } from '@sharkord/app-core';
import { getTRPCClient } from '@sharkord/app-core';

export default function VoiceChannelScreen() {
	const params = useLocalSearchParams<{ id: string }>();
	const navigation = useNavigation();
	const channelId = Number(params.id);
	const channel = useServerStore((state) => state.channels.find((entry) => entry.id === channelId));
	const currentVoiceChannelId = useServerStore(currentVoiceChannelIdSelector);
	const ownVoiceState = useServerStore(ownVoiceStateSelector);
	const voiceChannelState = useServerStore((state) => state.voiceMap[channelId]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		navigation.setOptions({ title: channel?.name ?? 'Voice' });
	}, [channel?.name, navigation]);

	useEffect(() => {
		if (!channelId || currentVoiceChannelId === channelId) {
			return;
		}

		void (async () => {
			setLoading(true);

			try {
				await getTRPCClient().voice.join.mutate({
					channelId,
					state: {
						micMuted: ownVoiceState.micMuted,
						soundMuted: ownVoiceState.soundMuted,
					},
				});

				useServerStore.getState().setCurrentVoiceChannelId(channelId);
			} finally {
				setLoading(false);
			}
		})();
	}, [channelId, currentVoiceChannelId, ownVoiceState.micMuted, ownVoiceState.soundMuted]);

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
					{loading ? 'Joining voice…' : 'Mobile voice transport scaffolding is active for presence and state.'}
				</Text>
			</View>

			<View style={{ flexDirection: 'row', gap: 12 }}>
				<Pressable
					onPress={() => {
						void getTRPCClient().voice.updateState.mutate({ micMuted: !ownVoiceState.micMuted });
						useServerStore.getState().updateOwnVoiceState({ micMuted: !ownVoiceState.micMuted });
					}}
					style={{
						alignItems: 'center',
						backgroundColor: ownVoiceState.micMuted ? '#7d2424' : '#102233',
						borderRadius: 12,
						flex: 1,
						paddingVertical: 14,
					}}
				>
					<Text style={{ color: '#f4fbff', fontWeight: '700' }}>
						{ownVoiceState.micMuted ? 'Unmute Mic' : 'Mute Mic'}
					</Text>
				</Pressable>
				<Pressable
					onPress={() => {
						void getTRPCClient().voice.updateState.mutate({ soundMuted: !ownVoiceState.soundMuted });
						useServerStore.getState().updateOwnVoiceState({ soundMuted: !ownVoiceState.soundMuted });
					}}
					style={{
						alignItems: 'center',
						backgroundColor: ownVoiceState.soundMuted ? '#7d2424' : '#102233',
						borderRadius: 12,
						flex: 1,
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
					void (async () => {
						await getTRPCClient().voice.leave.mutate();
						useServerStore.getState().setCurrentVoiceChannelId(undefined);
					})();
				}}
				style={{
					alignItems: 'center',
					backgroundColor: '#0e2b3e',
					borderRadius: 12,
					paddingVertical: 14,
				}}
			>
				<Text style={{ color: '#d7edf9', fontWeight: '700' }}>Leave Channel</Text>
			</Pressable>

			<View style={{ gap: 10 }}>
				<Text style={{ color: '#72d7ff', fontSize: 13, fontWeight: '700', textTransform: 'uppercase' }}>
					Participants
				</Text>
				{voiceUsers.map(({ state, user }) => (
					<View
						key={user?.id ?? Math.random()}
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
