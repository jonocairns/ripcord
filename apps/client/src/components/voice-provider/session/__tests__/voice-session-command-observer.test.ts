import { expect, mock, spyOn, test } from 'bun:test';
import type { TSpanObservation } from '@sharkord/shared/telemetry/tracing';
import * as browserLogger from '@/helpers/browser-logger';
import * as diagnostics from '@/helpers/desktop-diagnostics';
import * as delivery from '@/helpers/error-reporting/delivery';
import * as tracing from '@/helpers/telemetry/tracing';
import { voiceSessionCommandObserver } from '../voice-session-command-observer';

test('keeps cancelled and superseded commands distinct from successful and failed commands', () => {
	const finish = mock((_options: Parameters<TSpanObservation['finish']>[0]) => {});
	const start = spyOn(tracing, 'startSpanObservation').mockImplementation(() => ({
		run: (effect) => effect(),
		finish,
	}));
	const diagnostic = spyOn(diagnostics, 'recordDesktopDiagnostic').mockImplementation(() => {});
	const upload = spyOn(browserLogger, 'recordVoiceDiagnostic').mockImplementation(() => {});
	const identity = spyOn(delivery, 'getDiagnosticIdentity').mockReturnValue('server:user');
	try {
		for (const outcome of ['succeeded', 'cancelled', 'superseded', 'failed', 'expired', 'detached'] as const) {
			finish.mockClear();
			upload.mockClear();
			const observation = voiceSessionCommandObserver.start({
				commandType: 'RebuildTransports',
				commandId: 1,
				generation: 2,
				phase: 'rebuilding',
				attempt: 1,
			});
			observation.finish({ outcome, durationMs: 25, error: new Error('Bearer private') });
			expect(upload.mock.calls[0]?.[0]).toBe('Voice session command started');
			expect(upload.mock.calls[1]?.[0]).toBe('Voice session command finished');
			expect(upload.mock.calls[1]?.[1]).toMatchObject([
				{ commandType: 'RebuildTransports', commandId: 1, generation: 2, attempt: 1, outcome, durationMs: 25 },
			]);
			expect(upload.mock.calls[1]?.[2]).toBe(['failed', 'expired', 'detached'].includes(outcome) ? 'warning' : 'info');
			expect(finish).toHaveBeenCalledTimes(1);
			expect(finish).toHaveBeenCalledWith({
				attributes: { 'voice.outcome': outcome, 'voice.duration_ms': 25 },
				status:
					outcome === 'succeeded' ? 'ok' : outcome === 'cancelled' || outcome === 'superseded' ? 'unset' : 'error',
				statusMessage: outcome,
			});
		}
	} finally {
		start.mockRestore();
		diagnostic.mockRestore();
		upload.mockRestore();
		identity.mockRestore();
	}
});

test('a command finishing after a user/server switch cannot upload under the new identity', () => {
	const upload = spyOn(browserLogger, 'recordVoiceDiagnostic').mockImplementation(() => {});
	const identity = spyOn(delivery, 'getDiagnosticIdentity').mockReturnValue('server:user-a');
	try {
		const command = voiceSessionCommandObserver.start({
			commandType: 'RestoreVoiceSession',
			commandId: 1,
			generation: 1,
			phase: 'restoring',
			attempt: 1,
		});
		identity.mockReturnValue('server:user-b');
		command.finish({ outcome: 'failed', durationMs: 25 });
		expect(upload).toHaveBeenCalledTimes(1);
		expect(upload.mock.calls[0]?.[0]).toBe('Voice session command started');
	} finally {
		upload.mockRestore();
		identity.mockRestore();
	}
});
