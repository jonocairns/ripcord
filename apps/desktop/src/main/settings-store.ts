import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { parseWindowState, type TWindowState } from './window-state';

type TDesktopSettings = {
	serverUrl?: string;
	windowState?: unknown;
};

const SETTINGS_FILENAME = 'desktop-settings.json';

const getSettingsPath = () => {
	return path.join(app.getPath('userData'), SETTINGS_FILENAME);
};

const readSettings = async (): Promise<TDesktopSettings> => {
	try {
		const raw = await fs.readFile(getSettingsPath(), 'utf8');
		const parsed = JSON.parse(raw) as TDesktopSettings;

		if (!parsed || typeof parsed !== 'object') {
			return {};
		}

		return parsed;
	} catch {
		return {};
	}
};

const writeSettings = async (settings: TDesktopSettings) => {
	const settingsPath = getSettingsPath();

	await fs.mkdir(path.dirname(settingsPath), { recursive: true });
	await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
};

// Settings are read-modify-written as one JSON file, so chain updates to keep
// a window-size save from clobbering a concurrent server URL change.
let pendingSettingsUpdate: Promise<void> = Promise.resolve();

const updateSettings = (update: (settings: TDesktopSettings) => void) => {
	const nextUpdate = pendingSettingsUpdate.then(async () => {
		const settings = await readSettings();

		update(settings);

		await writeSettings(settings);
	});

	pendingSettingsUpdate = nextUpdate.catch(() => undefined);

	return nextUpdate;
};

const getServerUrl = async () => {
	const settings = await readSettings();
	return settings.serverUrl?.trim() || '';
};

const setServerUrl = async (serverUrl: string) => {
	const normalizedUrl = serverUrl.trim();

	await updateSettings((settings) => {
		settings.serverUrl = normalizedUrl;
	});
};

const getWindowState = async () => {
	const settings = await readSettings();
	return parseWindowState(settings.windowState);
};

const setWindowState = async (windowState: TWindowState) => {
	await updateSettings((settings) => {
		settings.windowState = windowState;
	});
};

export { getServerUrl, getWindowState, setServerUrl, setWindowState };
