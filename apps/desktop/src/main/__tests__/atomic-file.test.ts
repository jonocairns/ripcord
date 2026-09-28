import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { replaceFileAtomically } from '../atomic-file';

void describe('replaceFileAtomically', () => {
	void it('replaces an existing file after the temporary write succeeds', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ripcord-atomic-file-'));
		const targetPath = path.join(directory, 'desktop-settings.json');

		try {
			await fs.writeFile(targetPath, 'original');
			await replaceFileAtomically(targetPath, 'updated');

			assert.equal(await fs.readFile(targetPath, 'utf8'), 'updated');
			assert.deepEqual(await fs.readdir(directory), ['desktop-settings.json']);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	void it('keeps the existing file when the temporary write fails', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ripcord-atomic-file-'));
		const targetPath = path.join(directory, 'desktop-settings.json');

		try {
			await fs.writeFile(targetPath, 'original');
			await assert.rejects(
				replaceFileAtomically(targetPath, 'updated', {
					writeFile: async (filePath) => {
						await fs.writeFile(filePath, 'partial');
						throw new Error('Simulated write failure');
					},
					rename: fs.rename,
					unlink: fs.unlink,
				}),
				/Simulated write failure/,
			);

			assert.equal(await fs.readFile(targetPath, 'utf8'), 'original');
			assert.deepEqual(await fs.readdir(directory), ['desktop-settings.json']);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
