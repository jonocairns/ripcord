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

test('rotation between listing and reading retries instead of duplicating or omitting retained events', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ripcord-e2e-log-'));
	try {
		for (const [name, content] of Object.entries({
			'app2.log': 'oldest',
			'app1.log': 'previous',
			'app.log': 'current',
		}))
			await fs.writeFile(path.join(directory, name), content);
		let rotated = false;
		const read = async (file: URL) => {
			if (!rotated) {
				rotated = true;
				await fs.rm(path.join(directory, 'app2.log'));
				await fs.rename(path.join(directory, 'app1.log'), path.join(directory, 'app2.log'));
				await fs.rename(path.join(directory, 'app.log'), path.join(directory, 'app1.log'));
				await fs.writeFile(path.join(directory, 'app.log'), 'new-current');
			}
			return fs.readFile(file, 'utf8');
		};
		expect(await readServerLog(pathToFileURL(`${directory}/`), read)).toBe('previous\ncurrent\nnew-current');
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('a file missing during rotation triggers a complete retry', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ripcord-e2e-log-'));
	try {
		await fs.writeFile(path.join(directory, 'app.log'), 'original');
		let rotated = false;
		const read = async (file: URL) => {
			if (!rotated) {
				rotated = true;
				await fs.rename(file, path.join(directory, 'app1.log'));
				try {
					return await fs.readFile(file, 'utf8');
				} finally {
					await fs.writeFile(file, 'new-current');
				}
			}
			return fs.readFile(file, 'utf8');
		};
		expect(await readServerLog(pathToFileURL(`${directory}/`), read)).toBe('original\nnew-current');
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('continuous rotation fails explicitly after bounded retries', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ripcord-e2e-log-'));
	try {
		await fs.writeFile(path.join(directory, 'app.log'), 'original');
		let rotations = 0;
		const read = async (file: URL) => {
			if (file.pathname.endsWith('/app.log')) {
				rotations++;
				await fs.rename(file, path.join(directory, 'app1.log'));
				await fs.writeFile(file, `current-${rotations}`);
			}
			return fs.readFile(file, 'utf8');
		};
		await expect(readServerLog(pathToFileURL(`${directory}/`), read)).rejects.toThrow('after three attempts');
		expect(rotations).toBe(3);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
