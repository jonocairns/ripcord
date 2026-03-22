import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useServerStore } from '@sharkord/app-core';
import {
	clearPendingServerPasswordChallenge,
	ensureServerInfo,
	getPendingServerPasswordChallenge,
	getStoredIdentity,
	loginAndJoinServer,
} from '@/lib/runtime';

export default function LoginScreen() {
	const router = useRouter();
	const info = useServerStore((state) => state.info);
	const [identity, setIdentity] = useState('');
	const [password, setPassword] = useState('');
	const [serverPassword, setServerPassword] = useState('');
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const pendingServerPasswordChallenge = getPendingServerPasswordChallenge();

	useEffect(() => {
		void ensureServerInfo();
		void getStoredIdentity().then((value) => {
			if (value) {
				setIdentity(value);
			}
		});
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
				<Text style={{ color: '#f4fbff', fontSize: 28, fontWeight: '700' }}>{info?.name ?? 'Sharkord'}</Text>
				{info?.description ? <Text style={{ color: '#9dc3d8' }}>{info.description}</Text> : null}
				<TextInput
					autoCapitalize="none"
					autoCorrect={false}
					onChangeText={setIdentity}
					placeholder="Identity"
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
					value={identity}
				/>
				<TextInput
					onChangeText={setPassword}
					placeholder="Password"
					placeholderTextColor="#668298"
					secureTextEntry
					style={{
						backgroundColor: '#0b1724',
						borderColor: '#204764',
						borderRadius: 12,
						borderWidth: 1,
						color: '#f4fbff',
						paddingHorizontal: 14,
						paddingVertical: 14,
					}}
					value={password}
				/>
				{pendingServerPasswordChallenge ? (
					<TextInput
						onChangeText={setServerPassword}
						placeholder="Server password"
						placeholderTextColor="#668298"
						secureTextEntry
						style={{
							backgroundColor: '#0b1724',
							borderColor: '#204764',
							borderRadius: 12,
							borderWidth: 1,
							color: '#f4fbff',
							paddingHorizontal: 14,
							paddingVertical: 14,
						}}
						value={serverPassword}
					/>
				) : null}
				{error ? <Text style={{ color: '#ff8f8f' }}>{error}</Text> : null}
				<Pressable
					disabled={loading || !identity.trim() || !password.trim()}
					onPress={() => {
						void (async () => {
							setLoading(true);
							setError(undefined);

							try {
								const result = await loginAndJoinServer({
									identity,
									password,
									serverPassword: serverPassword || undefined,
								});

								if (result.kind === 'server-password-required') {
									setError('This server requires a server password in addition to your user credentials.');
									return;
								}

								clearPendingServerPasswordChallenge();
								router.replace('/(app)');
							} catch (nextError) {
								const data = (nextError as { data?: { errors?: Record<string, string> } }).data;

								setError(
									data?.errors?.identity ??
										data?.errors?.password ??
										(nextError instanceof Error ? nextError.message : 'Could not log in'),
								);
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
					<Text style={{ color: '#04131d', fontSize: 16, fontWeight: '700' }}>
						{loading ? 'Connecting…' : 'Connect'}
					</Text>
				</Pressable>
			</View>
		</View>
	);
}
