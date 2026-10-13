import { expect, test } from 'bun:test';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger, format } from 'winston';
import { createRotatingFileTransport } from '../log-retention';

test('server file retention rotates bounded archives and retains the newest complete JSON record', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ripcord-log-retention-'));
	const logger = createLogger({
		format: format.json(),
		transports: [createRotatingFileTransport(path.join(dir, 'app.log'), 'info', { maxSizeBytes: 1024, maxFiles: 3 })],
	});
	try {
		for (let index = 0; index < 30; index++) {
			logger.info({ message: `record-${index}`, padding: 'x'.repeat(500) });
			// Let rotations complete rather than overwhelming an artificial tiny budget.
			await Bun.sleep(5);
		}
		const finished = once(logger, 'finish');
		logger.end();
		await finished;
		for (let attempt = 0; attempt < 100; attempt++) {
			const latest = await fs.readFile(path.join(dir, 'app.log'), 'utf8');
			if (latest.includes('record-29')) break;
			await Bun.sleep(10);
		}
		const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.log'));
		expect(files.length).toBe(3);
		const latest = await fs.readFile(path.join(dir, 'app.log'), 'utf8');
		expect(latest).toContain('record-29');
		for (const file of files)
			for (const line of (await fs.readFile(path.join(dir, file), 'utf8')).trim().split('\n'))
				expect(() => JSON.parse(line)).not.toThrow();
	} finally {
		logger.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
