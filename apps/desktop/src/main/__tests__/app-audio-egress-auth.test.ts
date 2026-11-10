import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import { CaptureSidecarManager, isAppAudioBinaryEgressInfo } from '../capture-sidecar-manager';

const token = 'a1'.repeat(32);

// Exercise the manager through its private control pipe without loading Electron
// or relying on a platform capture backend.
const createManager = (info: unknown, onInfoRequest: () => void) =>
	new CaptureSidecarManager({
		spawnSidecar: () => {
			const child = spawn(
				process.execPath,
				[
					'-e',
					`
				const readline = require('node:readline');
				readline.createInterface({ input: process.stdin }).on('line', (line) => {
					const { id, method } = JSON.parse(line);
					let result = {};
					if (method === 'audio_capture.binary_egress_info') result = ${JSON.stringify(info)};
					if (method === 'audio_capture.start') result = {
						sessionId: 'session', targetId: 'target', sampleRate: 48000,
						channels: 2, framesPerBuffer: 960
					};
					process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\\n');
				});
			`,
				],
				{ stdio: ['pipe', 'pipe', 'pipe'] },
			);
			child.stdin.on('finish', () => child.kill());
			child.stdout.on('data', (data: Buffer) => {
				if (data.toString().includes('"port"')) onInfoRequest();
			});
			return child;
		},
	});

void describe('app audio egress authentication', () => {
	void it('requires a complete hexadecimal token in sidecar info', () => {
		for (const authToken of [undefined, '', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), `${token}\n`, 123]) {
			assert.equal(isAppAudioBinaryEgressInfo({ port: 1234, authToken }), false);
		}
		assert.equal(isAppAudioBinaryEgressInfo({ port: 1234, authToken: token }), true);
		assert.equal(isAppAudioBinaryEgressInfo({ port: 1234, authToken: token.toUpperCase() }), true);
	});

	void it('sends the token as the first socket bytes', async () => {
		const server = createServer();
		const sockets = new Set<import('node:net').Socket>();
		const handshake = new Promise<Buffer>((resolve) => {
			server.on('connection', (socket) => {
				sockets.add(socket);
				let received = Buffer.alloc(0);
				socket.on('data', (data) => {
					received = Buffer.concat([received, data]);
					if (received.length >= 64) resolve(received);
				});
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const manager = createManager({ port: address.port, authToken: token }, () => {});
		try {
			await manager.startAppAudioCapture({ sourceId: 'window:1:0' });
			const bytes = await Promise.race([
				handshake,
				new Promise<never>((_resolve, reject) => {
					setTimeout(() => reject(new Error('No authentication bytes received')), 2000).unref();
				}),
			]);
			assert.equal(bytes.toString('ascii'), token);
		} finally {
			await manager.dispose();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	void it('uses stdout for a stale sidecar and does not retry binary egress', async () => {
		let connections = 0;
		let infoRequests = 0;
		const server = createServer((socket) => {
			connections++;
			socket.destroy();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const manager = createManager({ port: address.port }, () => {
			infoRequests++;
		});
		try {
			assert.equal((await manager.startAppAudioCapture({ sourceId: 'window:1:0' })).sessionId, 'session');
			await manager.stopAppAudioCapture();
			await manager.startAppAudioCapture({ sourceId: 'window:1:0' });
			assert.equal(connections, 0);
			assert.equal(infoRequests, 1);
		} finally {
			await manager.dispose();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
