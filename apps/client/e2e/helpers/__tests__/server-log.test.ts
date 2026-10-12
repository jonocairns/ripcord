import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readServerLog } from '../server-log';

test('incident timelines include retained server archives in oldest-to-newest order', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ripcord-e2e-log-'));
	try {
		await Promise.all(
			Object.entries({
				'app.log': 'current',
				'app1.log': 'previous',
				'app2.log': 'oldest',
				'error.log': 'duplicate-errors',
				'app.log.tmp': 'temporary',
			}).map(([name, value]) => fs.writeFile(path.join(directory, name), value)),
		);
		expect(await readServerLog(pathToFileURL(`${directory}/`))).toBe('oldest\nprevious\ncurrent');
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
