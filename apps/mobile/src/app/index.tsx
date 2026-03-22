import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { bootstrapMobileSession } from '@/lib/runtime';

export default function IndexScreen() {
	const [targetRoute, setTargetRoute] = useState<string>();

	useEffect(() => {
		let mounted = true;

		void (async () => {
			const result = await bootstrapMobileSession();

			if (!mounted) {
				return;
			}

			if (result.status === 'needs-server') {
				setTargetRoute('/connect');
				return;
			}

			if (result.status === 'needs-login') {
				setTargetRoute('/login');
				return;
			}

			setTargetRoute('/(app)');
		})();

		return () => {
			mounted = false;
		};
	}, []);

	if (targetRoute) {
		return <Redirect href={targetRoute as never} />;
	}

	return (
		<View
			style={{
				alignItems: 'center',
				backgroundColor: '#08121c',
				flex: 1,
				gap: 16,
				justifyContent: 'center',
				padding: 24,
			}}
		>
			<ActivityIndicator color="#72d7ff" size="large" />
			<Text style={{ color: '#d7edf9', fontSize: 16 }}>Bootstrapping Sharkord mobile…</Text>
		</View>
	);
}
