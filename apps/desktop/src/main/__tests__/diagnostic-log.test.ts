import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createDiagnosticLog, sanitizeDiagnosticData, validateDiagnosticEvent } from '../diagnostic-log';

const createLog = (directory: string, maxFileBytes?: number) =>
	createDiagnosticLog({
		directory,
		maxFileBytes,
		appVersion: '2.4.0',
		platform: 'win32',
		homeDirectory: 'C:\\Users\\jono',
	});

void describe('desktop diagnostics', () => {
	void it('redacts credentials and private payloads while retaining correlation IDs and errors', () => {
		assert.deepEqual(
			sanitizeDiagnosticData(
				{
					token: 'plain-secret',
					srtpKey: 'media-secret',
					content: 'chat message',
					label: 'private window title',
					clientInstanceId: '1b051ae1-82cd-4e20-aaa7-daa572fc5eeb',
					details: {
						error: new Error(
							'Failed at C:\\Users\\jono\\app https://host/path?token=secret for me@example.com 192.168.1.75',
						),
					},
				},
				'C:\\Users\\jono',
			),
			{
				token: '[redacted]',
				srtpKey: '[redacted]',
				content: '[redacted]',
				label: '[redacted]',
				clientInstanceId: '1b051ae1-82cd-4e20-aaa7-daa572fc5eeb',
				details: {
					error: { name: 'Error', message: 'Failed at ~\\app [redacted-url] for [redacted-email] [redacted-ip]' },
				},
			},
		);
	});

	void it('validates renderer event names and levels and ignores injected record metadata', () => {
		assert.equal(validateDiagnosticEvent({ event: '../escape', level: 'info' }), undefined);
		assert.equal(validateDiagnosticEvent({ event: 'voice', level: 'fatal' }), undefined);
		assert.deepEqual(
			validateDiagnosticEvent({
				event: 'voice',
				level: 'warn',
				appVersion: 'fake',
				source: 'main',
				data: { attempt: 2 },
			}),
			{
				event: 'voice',
				level: 'warn',
				data: { attempt: 2 },
			},
		);
	});

	void it('serializes concurrent writes, rotates within five files, and retains startup metadata', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'ripcord-diagnostics-'));
		try {
			const log = createLog(directory, 600);
			await Promise.all(
				Array.from({ length: 20 }, (_, index) => log.write({ event: 'voice', level: 'info', data: { index } })),
			);
			await log.flush();
			assert.equal((await readdir(directory)).length, 5);
			const allLines: string[] = [];
			for (const suffix of ['.4', '.3', '.2', '.1', '']) {
				const text = await readFile(path.join(directory, `diagnostics.jsonl${suffix}`), 'utf8');
				assert.ok(Buffer.byteLength(text) <= 600);
				allLines.push(...text.trim().split('\n'));
			}
			const records = allLines.map((line) => JSON.parse(line));
			const indices = records.map((record) => record.data.index);
			assert.deepEqual(
				indices,
				Array.from({ length: indices.length }, (_, index) => 20 - indices.length + index),
			);
			assert.equal(records.at(-1)?.data.index, 19);
			assert.equal(new Set(records.map((record) => record.sessionId)).size, 1);
			assert.ok(
				records.every(
					(record) => record.appVersion === '2.4.0' && record.platform === 'win32' && record.timestamp.endsWith('Z'),
				),
			);
			// A restarted process must account for the existing active file's size.
			await createLog(directory, 600).write({ event: 'desktop_started', level: 'info' });
			assert.ok(Buffer.byteLength(await readFile(path.join(directory, 'diagnostics.jsonl'))) <= 600);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	void it('bounds queued writes and oversized records, and records dropped events', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'ripcord-diagnostics-'));
		try {
			const log = createLog(directory);
			await Promise.all(Array.from({ length: 300 }, () => log.write({ event: 'voice', level: 'info' })));
			await log.write({ event: 'recovered', level: 'info', data: Array.from({ length: 20 }, () => 'x'.repeat(2048)) });
			const lines = (await readFile(path.join(directory, 'diagnostics.jsonl'), 'utf8')).trim().split('\n');
			assert.equal(lines.length, 257);
			const last = JSON.parse(lines.at(-1) ?? 'null');
			assert.equal(last.droppedEvents, 44);
			assert.deepEqual(last.data, { truncated: true });
			assert.ok(lines.every((line) => Buffer.byteLength(line) < 8192));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	void it('contains filesystem failures and resumes writing when the directory becomes available', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'ripcord-diagnostics-'));
		try {
			const blockedPath = path.join(directory, 'logs');
			await writeFile(blockedPath, 'blocked');
			const log = createLog(blockedPath);
			await log.write({ event: 'failed_write', level: 'error' });
			await rm(blockedPath);
			await log.write({ event: 'recovered', level: 'info' });
			const record = JSON.parse(await readFile(path.join(blockedPath, 'diagnostics.jsonl'), 'utf8'));
			assert.equal(record.event, 'recovered');
			assert.equal(record.droppedEvents, 1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
