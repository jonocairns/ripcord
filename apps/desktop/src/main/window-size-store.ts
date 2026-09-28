import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { parseWindowSize, type TWindowSize } from './window-size';

const WINDOW_SIZE_FILENAME = 'desktop-window-size.json';
let previousSave: Promise<void> = Promise.resolve();

const getWindowSizePath = () => path.join(app.getPath('userData'), WINDOW_SIZE_FILENAME);

const getWindowSize = async () => {
	try {
		return parseWindowSize(JSON.parse(await fs.readFile(getWindowSizePath(), 'utf8')));
	} catch {
		return undefined;
	}
};

const setWindowSize = (windowSize: TWindowSize) => {
	const save = previousSave
		.catch(() => undefined)
		.then(async () => {
			const windowSizePath = getWindowSizePath();
			await fs.mkdir(path.dirname(windowSizePath), { recursive: true });
			await fs.writeFile(windowSizePath, JSON.stringify(windowSize), 'utf8');
		});
	previousSave = save;
	return save;
};

export { getWindowSize, setWindowSize };
