import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '@/lib/runtime';

const rootStackScreenOptions = {
	animation: 'fade' as const,
	contentStyle: { backgroundColor: '#08121c' },
	headerShown: false,
};

export default function RootLayout() {
	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<SafeAreaProvider>
				<StatusBar style="light" />
				<Stack screenOptions={rootStackScreenOptions} />
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
