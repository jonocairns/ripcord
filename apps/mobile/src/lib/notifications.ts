import AsyncStorage from '@react-native-async-storage/async-storage';
import { getTRPCClient } from '@sharkord/app-core';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const INSTALLATION_ID_KEY = 'sharkord-mobile-installation-id';

Notifications.setNotificationHandler({
	handleNotification: async () => ({
		shouldPlaySound: true,
		shouldSetBadge: true,
		shouldShowBanner: true,
		shouldShowList: true,
	}),
});

const getInstallationId = async () => {
	const existing = await AsyncStorage.getItem(INSTALLATION_ID_KEY);

	if (existing) {
		return existing;
	}

	const installationId = crypto.randomUUID();
	await AsyncStorage.setItem(INSTALLATION_ID_KEY, installationId);

	return installationId;
};

const getExpoPushToken = async (): Promise<string | undefined> => {
	if (!Device.isDevice) {
		return undefined;
	}

	if (Platform.OS === 'android') {
		await Notifications.setNotificationChannelAsync('default', {
			importance: Notifications.AndroidImportance.MAX,
			lightColor: '#72d7ff',
			name: 'default',
			vibrationPattern: [0, 250, 250, 250],
		});
	}

	const existingPermissions = await Notifications.getPermissionsAsync();
	let finalStatus = existingPermissions.status;

	if (finalStatus !== 'granted') {
		const requestedPermissions = await Notifications.requestPermissionsAsync();
		finalStatus = requestedPermissions.status;
	}

	if (finalStatus !== 'granted') {
		return undefined;
	}

	const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

	if (!projectId) {
		return undefined;
	}

	try {
		const token = await Notifications.getExpoPushTokenAsync({ projectId });
		return token.data;
	} catch {
		return undefined;
	}
};

const syncPushRegistration = async () => {
	const expoPushToken = await getExpoPushToken();

	if (!expoPushToken) {
		return;
	}

	await getTRPCClient().others.registerPushDevice.mutate({
		expoPushToken,
		installationId: await getInstallationId(),
		platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'unknown',
	});
};

export { syncPushRegistration };
