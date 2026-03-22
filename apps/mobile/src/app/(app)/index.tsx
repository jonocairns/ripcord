import { useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ChannelType } from '@sharkord/shared';
import { useServerStore } from '@sharkord/app-core';
import { syncPushRegistration } from '@/lib/notifications';

export default function HomeScreen() {
	const router = useRouter();
	const info = useServerStore((state) => state.info);
	const categories = useServerStore((state) => state.categories);
	const channels = useServerStore((state) => state.channels);

	useEffect(() => {
		void syncPushRegistration().catch(() => {
			// Push registration is best-effort until credentials are configured.
		});
	}, []);

	const uncategorizedChannels = useMemo(() => {
		return channels.filter((channel) => channel.categoryId == null).sort((a, b) => a.position - b.position);
	}, [channels]);

	return (
		<ScrollView style={{ backgroundColor: '#08121c', flex: 1 }} contentContainerStyle={{ gap: 18, padding: 20 }}>
			<View style={{ gap: 8 }}>
				<Text style={{ color: '#f4fbff', fontSize: 28, fontWeight: '700' }}>{info?.name ?? 'Sharkord'}</Text>
				<Text style={{ color: '#9dc3d8', fontSize: 15 }}>
					{info?.description || 'Choose a channel to jump into the server.'}
				</Text>
			</View>

			{uncategorizedChannels.length > 0 ? (
				<View style={{ gap: 10 }}>
					<Text style={{ color: '#72d7ff', fontSize: 13, fontWeight: '700', textTransform: 'uppercase' }}>
						Channels
					</Text>
					{uncategorizedChannels.map((channel) => (
						<Pressable
							key={channel.id}
							onPress={() => {
								router.push(
									channel.type === ChannelType.VOICE ? `/(app)/voice/${channel.id}` : `/(app)/channel/${channel.id}`,
								);
							}}
							style={{
								backgroundColor: '#102233',
								borderColor: '#1b3d56',
								borderRadius: 14,
								borderWidth: 1,
								padding: 16,
							}}
						>
							<Text style={{ color: '#f4fbff', fontSize: 16, fontWeight: '600' }}>{channel.name}</Text>
							<Text style={{ color: '#8eb0c6', marginTop: 4 }}>
								{channel.type === ChannelType.VOICE ? 'Voice channel' : 'Text channel'}
							</Text>
						</Pressable>
					))}
				</View>
			) : null}

			{categories
				.slice()
				.sort((a, b) => a.position - b.position)
				.map((category) => {
					const categoryChannels = channels
						.filter((channel) => channel.categoryId === category.id)
						.sort((a, b) => a.position - b.position);

					if (categoryChannels.length === 0) {
						return null;
					}

					return (
						<View key={category.id} style={{ gap: 10 }}>
							<Text style={{ color: '#72d7ff', fontSize: 13, fontWeight: '700', textTransform: 'uppercase' }}>
								{category.name}
							</Text>
							{categoryChannels.map((channel) => (
								<Pressable
									key={channel.id}
									onPress={() => {
										router.push(
											channel.type === ChannelType.VOICE
												? `/(app)/voice/${channel.id}`
												: `/(app)/channel/${channel.id}`,
										);
									}}
									style={{
										backgroundColor: '#102233',
										borderColor: '#1b3d56',
										borderRadius: 14,
										borderWidth: 1,
										padding: 16,
									}}
								>
									<Text style={{ color: '#f4fbff', fontSize: 16, fontWeight: '600' }}>{channel.name}</Text>
									<Text style={{ color: '#8eb0c6', marginTop: 4 }}>
										{channel.type === ChannelType.VOICE ? 'Voice channel' : 'Text channel'}
									</Text>
								</Pressable>
							))}
						</View>
					);
				})}

			<Pressable
				onPress={() => router.push('/(app)/settings')}
				style={{
					alignItems: 'center',
					backgroundColor: '#0e2b3e',
					borderRadius: 14,
					paddingVertical: 14,
				}}
			>
				<Text style={{ color: '#d7edf9', fontWeight: '700' }}>Settings</Text>
			</Pressable>
		</ScrollView>
	);
}
