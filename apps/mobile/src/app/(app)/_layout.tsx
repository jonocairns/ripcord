import { Stack } from 'expo-router';

const appStackScreenOptions = {
	contentStyle: { backgroundColor: '#08121c' },
	headerStyle: { backgroundColor: '#0d1a27' },
	headerTintColor: '#f4fbff',
};

export default function AppLayout() {
	return <Stack screenOptions={appStackScreenOptions} />;
}
