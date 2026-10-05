import { describe, expect, it } from 'bun:test';
import { runVoiceRecoveryTest } from '../voice-recovery-test';

const createHarness = () => {
	const calls: string[] = [];
	const operations = {
		run: async () => {
			calls.push('scenario');
		},
		attachDiagnostics: async () => {
			calls.push('diagnostics');
		},
		resumeOutage: () => {
			calls.push('resume');
		},
		disposePeers: [
			async () => {
				calls.push('producer');
			},
			async () => {
				calls.push('watcher');
			},
		],
	};
	return { calls, operations };
};

describe('voice recovery test teardown', () => {
	it('attaches diagnostics and releases both peers after a successful scenario', async () => {
		const h = createHarness();
		await runVoiceRecoveryTest(h.operations);
		expect(h.calls).toEqual(['scenario', 'diagnostics', 'resume', 'producer', 'watcher']);
	});

	it('rethrows the original assertion after collecting diagnostics and disposing both peers', async () => {
		const h = createHarness();
		const assertion = new Error('microphone RTP did not advance');
		h.operations.run = async () => {
			throw assertion;
		};
		await expect(runVoiceRecoveryTest(h.operations)).rejects.toBe(assertion);
		expect(h.calls).toEqual(['diagnostics', 'resume', 'producer', 'watcher']);
	});

	it.each(['server log read', 'diagnostic attachment'])('cleans both peers when %s fails', async (boundary) => {
		const h = createHarness();
		const diagnostic = new Error(`${boundary} failed`);
		h.operations.attachDiagnostics = async () => {
			h.calls.push('read-log');
			if (boundary === 'server log read') throw diagnostic;
			h.calls.push('attach-log');
			throw diagnostic;
		};
		await expect(runVoiceRecoveryTest(h.operations)).rejects.toBe(diagnostic);
		expect(h.calls).toEqual([
			'scenario',
			'read-log',
			...(boundary === 'diagnostic attachment' ? ['attach-log'] : []),
			'resume',
			'producer',
			'watcher',
		]);
	});

	it('preserves the assertion as the cause and exposes every diagnostic and cleanup failure', async () => {
		const h = createHarness();
		const assertion = new Error('fresh restore was not observed');
		const diagnostic = new Error('server log is unavailable');
		const release = new Error('held signaling could not resume');
		const producer = new Error('producer context close failed');
		h.operations.run = async () => {
			throw assertion;
		};
		h.operations.attachDiagnostics = async () => {
			throw diagnostic;
		};
		h.operations.resumeOutage = () => {
			throw release;
		};
		h.operations.disposePeers[0] = async () => {
			h.calls.push('producer');
			throw producer;
		};

		const error: unknown = await runVoiceRecoveryTest(h.operations).catch((failure: unknown) => failure);
		if (!(error instanceof AggregateError)) throw new Error('Expected all recovery-test failures to be reported');
		expect(error.cause).toBe(assertion);
		expect(error.errors).toEqual([assertion, diagnostic, release, producer]);
		expect(error.message).toContain('Scenario: fresh restore was not observed');
		expect(error.message).toContain('Diagnostics: server log is unavailable');
		expect(error.message).toContain('Outage release: held signaling could not resume');
		expect(error.message).toContain('Peer 1 cleanup: producer context close failed');
		expect(h.calls).toEqual(['producer', 'watcher']);
	});

	it('attempts watcher disposal after producer disposal rejects', async () => {
		const h = createHarness();
		const close = new Error('producer close failed');
		h.operations.disposePeers[0] = async () => {
			h.calls.push('producer');
			throw close;
		};
		await expect(runVoiceRecoveryTest(h.operations)).rejects.toBe(close);
		expect(h.calls).toEqual(['scenario', 'diagnostics', 'resume', 'producer', 'watcher']);
	});

	it('preserves non-Error failures while still releasing both peers', async () => {
		const h = createHarness();
		h.operations.run = async () => {
			throw undefined;
		};
		h.operations.attachDiagnostics = async () => {
			throw 'attachment unavailable';
		};
		const error: unknown = await runVoiceRecoveryTest(h.operations).catch((failure: unknown) => failure);
		if (!(error instanceof AggregateError)) throw new Error('Expected non-Error failures to be retained');
		expect(error.errors).toEqual([undefined, 'attachment unavailable']);
		expect(error.message).toContain('Scenario: undefined');
		expect(error.message).toContain('Diagnostics: attachment unavailable');
		expect(h.calls).toEqual(['resume', 'producer', 'watcher']);
	});
});
