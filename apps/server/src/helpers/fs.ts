import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ensureDir = async (path: string) => {
	await fs.mkdir(path, { recursive: true });
};

const getAppDataPath = (): string => {
	const platform = process.platform;

	if (platform === 'win32') {
		// Windows → C:\Users\<User>\AppData\Roaming
		return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
	}

	if (platform === 'darwin') {
		// macOS → ~/Library/Application Support
		return path.join(os.homedir(), 'Library', 'Application Support');
	}

	// Linux → ~/.config
	return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
};

export { ensureDir, getAppDataPath };
