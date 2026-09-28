import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { createLatestAtomicFileWriter } from './atomic-file';
import { parseWindowSize, type TWindowSize } from './window-size';

const WINDOW_SIZE_FILENAME = 'desktop-window-size.json';
const replaceLatestWindowSize = createLatestAtomicFileWriter();

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

	await replaceLatestWindowSize(windowSizePath, JSON.stringify(windowSize, null, 2));
};

export { getWindowSize, setWindowSize };
