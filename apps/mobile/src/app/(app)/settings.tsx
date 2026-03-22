import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useServerStore } from '@sharkord/app-core';
import { mobileLogout } from '@/lib/runtime';

export default function SettingsScreen() {
	const router = useRouter();
	const info = useServerStore((state) => state.info);
	const ownUser = useServerStore((state) => state.users.find((user) => user.id === state.ownUserId));

	return (
		<View style={{ backgroundColor: '#08121c', flex: 1, gap: 18, padding: 20 }}>
			<View
				style={{
					backgroundColor: '#102233',
					borderColor: '#1b3d56',
					borderRadius: 14,
					borderWidth: 1,
					gap: 8,
					padding: 16,
				}}
			>
				<Text style={{ color: '#f4fbff', fontSize: 22, fontWeight: '700' }}>Settings</Text>
				<Text style={{ color: '#9dc3d8' }}>Server: {info?.name ?? 'Unknown'}</Text>
				<Text style={{ color: '#9dc3d8' }}>Signed in as: {ownUser?.name ?? ownUser?._identity ?? 'Unknown'}</Text>
			</View>

			<Pressable
				onPress={() => {
					void (async () => {
						await mobileLogout();
						router.replace('/login');
					})();
				}}
				style={{
					alignItems: 'center',
					backgroundColor: '#7d2424',
					borderRadius: 12,
					paddingVertical: 14,
				}}
			>
				<Text style={{ color: '#fff4f4', fontWeight: '700' }}>Log out</Text>
			</Pressable>
		</View>
	);
}
