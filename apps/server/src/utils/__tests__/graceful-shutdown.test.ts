import { describe, expect, mock, test } from 'bun:test';
import { performGracefulShutdown, type TShutdownResources } from '../graceful-shutdown';

const makeDeps = () => {
	const calls: string[] = [];
	return {
		calls,
		deps: {
			flush: mock(async () => {
				calls.push('flush');
			}),
			exit: mock((code: number) => {
				calls.push(`exit:${code}`);
			}),
			sleep: mock(async () => {
				calls.push('drain');
			}),
			drainMs: 3_000,
		},
	};
};

describe('performGracefulShutdown', () => {
	test('stops accepting connections before broadcast → drain → resource cleanup → flush → exit', async () => {
		const { calls, deps } = makeDeps();

		const resources: TShutdownResources = {
			broadcastReconnect: () => {
				calls.push('broadcast');
			},
			closeServers: () => {
				calls.push('closeServers');
			},
			closeMedia: () => {
				calls.push('closeMedia');
			},
			closeDb: () => {
				calls.push('closeDb');
			},
		};

		await performGracefulShutdown('SIGTERM', resources, deps);

		expect(calls).toEqual(['closeServers', 'broadcast', 'drain', 'closeMedia', 'closeDb', 'flush', 'exit:143']);
	});

	test('SIGINT exits 130', async () => {
		const { calls, deps } = makeDeps();
		await performGracefulShutdown('SIGINT', {}, deps);
		expect(calls.at(-1)).toBe('exit:130');
	});

	test('skips the drain when there is nothing to broadcast (e.g. signal during boot)', async () => {
		const { calls, deps } = makeDeps();
		await performGracefulShutdown(
			'SIGTERM',
			{
				closeDb: () => {
					calls.push('closeDb');
				},
			},
			deps,
		);

		expect(deps.sleep).not.toHaveBeenCalled();
		expect(calls).toEqual(['closeDb', 'flush', 'exit:143']);
	});

	test('a failing step does not abort the rest — we still flush and exit', async () => {
		const { calls, deps } = makeDeps();

		const resources: TShutdownResources = {
			closeServers: () => {
				throw new Error('server close blew up');
			},
			closeDb: () => {
				calls.push('closeDb');
			},
		};

		await performGracefulShutdown('SIGTERM', resources, deps);

		// closeServers threw but was swallowed; closeDb, flush and exit still ran.
		expect(calls).toEqual(['closeDb', 'flush', 'exit:143']);
		expect(deps.exit).toHaveBeenCalledTimes(1);
	});

	test('always flushes telemetry before exiting', async () => {
		const { calls, deps } = makeDeps();
		await performGracefulShutdown('SIGTERM', {}, deps);

		const flushIndex = calls.indexOf('flush');
		const exitIndex = calls.findIndex((c) => c.startsWith('exit:'));
		expect(flushIndex).toBeGreaterThanOrEqual(0);
		expect(exitIndex).toBe(flushIndex + 1);
	});
});
