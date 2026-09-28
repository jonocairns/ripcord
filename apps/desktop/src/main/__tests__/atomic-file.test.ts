import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createLatestAtomicFileWriter, replaceFileAtomically } from '../atomic-file';

const createGate = () => {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});

	return { promise, release: () => release() };
};

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

void describe('createLatestAtomicFileWriter', () => {
	void it('skips an older save that finishes writing after a newer one', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ripcord-window-size-'));
		const targetPath = path.join(directory, 'desktop-window-size.json');
		const oldWriteStarted = createGate();
		const finishOldWrite = createGate();
		const write = createLatestAtomicFileWriter({
			writeFile: async (filePath, contents, options) => {
				if (contents === 'old') {
					oldWriteStarted.release();
					await finishOldWrite.promise;
				}
				await fs.writeFile(filePath, contents, options);
			},
			rename: fs.rename,
			unlink: fs.unlink,
		});
		const oldSave = write(targetPath, 'old');

		try {
			await oldWriteStarted.promise;
			await write(targetPath, 'new');
			finishOldWrite.release();
			await oldSave;

			assert.equal(await fs.readFile(targetPath, 'utf8'), 'new');
			assert.deepEqual(await fs.readdir(directory), ['desktop-window-size.json']);
		} finally {
			finishOldWrite.release();
			await oldSave.catch(() => undefined);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	void it('commits a newer save after an older rename finishes', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ripcord-window-size-'));
		const targetPath = path.join(directory, 'desktop-window-size.json');
		const oldRenameStarted = createGate();
		const finishOldRename = createGate();
		const newWriteFinished = createGate();
		const write = createLatestAtomicFileWriter({
			writeFile: async (filePath, contents, options) => {
				await fs.writeFile(filePath, contents, options);
				if (contents === 'new') {
					newWriteFinished.release();
				}
			},
			rename: async (from, to) => {
				if ((await fs.readFile(from, 'utf8')) === 'old') {
					oldRenameStarted.release();
					await finishOldRename.promise;
				}
				await fs.rename(from, to);
			},
			unlink: fs.unlink,
		});
		const oldSave = write(targetPath, 'old');
		let newSave: Promise<void> | undefined;

		try {
			await oldRenameStarted.promise;
			newSave = write(targetPath, 'new');
			await newWriteFinished.promise;
			finishOldRename.release();
			await Promise.all([oldSave, newSave]);

			assert.equal(await fs.readFile(targetPath, 'utf8'), 'new');
			assert.deepEqual(await fs.readdir(directory), ['desktop-window-size.json']);
		} finally {
			finishOldRename.release();
			await Promise.all([oldSave.catch(() => undefined), newSave?.catch(() => undefined)]);
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
