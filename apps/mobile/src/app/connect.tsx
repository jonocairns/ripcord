import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { ensureServerInfo, getServerUrl, normalizeServerUrl, setServerUrl } from '@/lib/runtime';

export default function ConnectScreen() {
	const router = useRouter();
	const [serverUrl, setServerUrlValue] = useState(getServerUrl());
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		setServerUrlValue(getServerUrl());
	}, []);

	return (
		<View style={{ backgroundColor: '#08121c', flex: 1, justifyContent: 'center', padding: 24 }}>
			<View
				style={{
					backgroundColor: '#102233',
					borderColor: '#1b3d56',
					borderRadius: 18,
					borderWidth: 1,
					gap: 16,
					padding: 20,
				}}
			>
				<Text style={{ color: '#f4fbff', fontSize: 28, fontWeight: '700' }}>Connect to a server</Text>
				<Text style={{ color: '#9dc3d8', fontSize: 15 }}>
					Sharkord mobile currently connects to a single configured server.
				</Text>
				<TextInput
					autoCapitalize="none"
					autoCorrect={false}
					onChangeText={setServerUrlValue}
					placeholder="https://chat.example.com"
					placeholderTextColor="#668298"
					style={{
						backgroundColor: '#0b1724',
						borderColor: '#204764',
						borderRadius: 12,
						borderWidth: 1,
						color: '#f4fbff',
						paddingHorizontal: 14,
						paddingVertical: 14,
					}}
					value={serverUrl}
				/>
				{error ? <Text style={{ color: '#ff8f8f' }}>{error}</Text> : null}
				<Pressable
					disabled={loading || !serverUrl.trim()}
					onPress={() => {
						void (async () => {
							setLoading(true);
							setError(undefined);

							try {
								const normalized = normalizeServerUrl(serverUrl);
								await setServerUrl(normalized);
								await ensureServerInfo();
								router.replace('/login');
							} catch (nextError) {
								setError(nextError instanceof Error ? nextError.message : 'Could not save server URL');
							} finally {
								setLoading(false);
							}
						})();
					}}
					style={{
						alignItems: 'center',
						backgroundColor: loading ? '#315267' : '#72d7ff',
						borderRadius: 12,
						paddingVertical: 14,
					}}
				>
					<Text style={{ color: '#04131d', fontSize: 16, fontWeight: '700' }}>{loading ? 'Saving…' : 'Continue'}</Text>
				</Pressable>
			</View>
		</View>
	);
}
