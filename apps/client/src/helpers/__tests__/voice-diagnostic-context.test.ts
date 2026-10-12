import { expect, test } from 'bun:test';
import { getVoiceDiagnosticContext } from '../voice-diagnostic-context';

test('voice diagnostics retain bounded recovery, transport and media intent evidence', () => {
	expect(
		getVoiceDiagnosticContext([
			{
				transportId: 'transport-1',
				state: 'disconnected',
				attempt: 2,
				durationMs: 25.5,
				commandType: 'RestoreVoiceSession',
				phase: 'restoring',
				outcome: 'failed',
				micMuted: true,
				failure: { userId: 7, source: 'media-liveness', transportId: 'transport-2' },
				error: Object.assign(new TypeError('private user payload'), { data: { code: 'TIMEOUT' } }),
			},
		]),
	).toEqual({
		transportId: 'transport-2',
		state: 'disconnected',
		attempt: 2,
		durationMs: 25.5,
		commandType: 'RestoreVoiceSession',
		phase: 'restoring',
		outcome: 'failed',
		micMuted: true,
		userId: 7,
		source: 'media-liveness',
		errorType: 'TypeError',
		errorCode: 'TIMEOUT',
	});
});

test('voice diagnostics exclude free text, device labels, addresses, nested payloads and invalid values', () => {
	const context = getVoiceDiagnosticContext([
		{
			state: 'user@example.com',
			constructor: 'private prototype key',
			toString: 'private prototype key',
			reason: 'Bearer private-token',
			protocol: 'https://private',
			attempt: -1,
			generation: Infinity,
			durationMs: NaN,
			closeCode: 999,
			producerId: 'private@example.com',
			micMuted: 'true',
			deviceLabel: 'Private Microphone',
			ip: '192.168.1.2',
			sdp: 'secret SDP',
			params: { transportId: 'unwanted-id' },
			error: {
				name: 'private@example.com',
				message: 'secret',
				stack: 'private stack',
				data: { code: 'private' },
				errorCode: 10000,
			},
			intent: { sharingScreen: true, deviceLabel: 'Private Display' },
			failure: { source: 'consumer-dtls', params: { transportId: 'too-deep' } },
		},
	]);
	expect(context).toEqual({ sharingScreen: true, source: 'consumer-dtls' });
});

test('WebSocket diagnostics retain close codes without arbitrary close reasons and stay within record budgets', () => {
	expect(
		getVoiceDiagnosticContext([
			{ closeCode: 1006, wasClean: false, online: true, reason: 'custom private close reason' },
		]),
	).toEqual({ closeCode: 1006, wasClean: false, online: true });
	expect(
		Object.keys(getVoiceDiagnosticContext(Array.from({ length: 100 }, (_, attempt) => ({ attempt })))),
	).toHaveLength(1);
	expect(getVoiceDiagnosticContext([null, ['private'], 'private', { attempt: 2 }])).toEqual({ attempt: 2 });
});
