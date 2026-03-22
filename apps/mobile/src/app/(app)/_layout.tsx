import { Stack } from 'expo-router';

export default function AppLayout() {
	return (
		<Stack
			screenOptions={{
				contentStyle: { backgroundColor: '#08121c' },
				headerStyle: { backgroundColor: '#0d1a27' },
				headerTintColor: '#f4fbff',
			}}
		/>
	);
}
