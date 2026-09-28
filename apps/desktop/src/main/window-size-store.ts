import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { parseWindowSize, type TWindowSize } from './window-size';

const WINDOW_SIZE_FILENAME = 'desktop-window-size.json';

const getWindowSizePath = () => path.join(app.getPath('userData'), WINDOW_SIZE_FILENAME);

const getWindowSize = async () => {
	try {
		return parseWindowSize(JSON.parse(await fs.readFile(getWindowSizePath(), 'utf8')));
	} catch {
		return undefined;
	}
};

const setWindowSize = async (windowSize: TWindowSize) => {
	const windowSizePath = getWindowSizePath();
	const temporaryPath = `${windowSizePath}.${randomUUID()}.tmp`;
	await fs.mkdir(path.dirname(windowSizePath), { recursive: true });
	try {
		await fs.writeFile(temporaryPath, JSON.stringify(windowSize), 'utf8');
		await fs.rename(temporaryPath, windowSizePath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
};

export { getWindowSize, setWindowSize };
