import { Stack } from 'expo-router';
import { MobileVoiceProvider } from '@/components/mobile-voice-provider';

const appStackScreenOptions = {
	contentStyle: { backgroundColor: '#08121c' },
	headerStyle: { backgroundColor: '#0d1a27' },
	headerTintColor: '#f4fbff',
};

export default function AppLayout() {
	return (
		<MobileVoiceProvider>
			<Stack screenOptions={appStackScreenOptions} />
		</MobileVoiceProvider>
	);
}
