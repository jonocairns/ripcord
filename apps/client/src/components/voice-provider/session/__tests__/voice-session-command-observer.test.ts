import { expect, mock, spyOn, test } from 'bun:test';
import type { TSpanObservation } from '@sharkord/shared/telemetry/tracing';
import * as diagnostics from '@/helpers/desktop-diagnostics';
import * as tracing from '@/helpers/telemetry/tracing';
import { voiceSessionCommandObserver } from '../voice-session-command-observer';

test('keeps cancelled and superseded commands distinct from successful and failed commands', () => {
	const finish = mock((_options: Parameters<TSpanObservation['finish']>[0]) => {});
	const start = spyOn(tracing, 'startSpanObservation').mockImplementation(() => ({
		run: (effect) => effect(),
		finish,
	}));
	const diagnostic = spyOn(diagnostics, 'recordDesktopDiagnostic').mockImplementation(() => {});
	try {
		for (const outcome of ['succeeded', 'cancelled', 'superseded', 'failed', 'expired', 'detached'] as const) {
			finish.mockClear();
			const observation = voiceSessionCommandObserver.start({
				commandType: 'RebuildTransports',
				commandId: 1,
				generation: 2,
				phase: 'rebuilding',
				attempt: 1,
			});
			observation.finish({ outcome, durationMs: 25, error: new Error('Bearer private') });
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
	}
});
