import { describe, expect, it, mock, spyOn } from 'bun:test';
import type { Event } from '@sentry/react';
import type { TDiagnosticBatch } from '@sharkord/shared';
import { logVoice, recordVoiceDiagnostic } from '../browser-logger';
import {
	authenticateDiagnosticDelivery,
	clearDiagnosticDelivery,
	configureDiagnosticDelivery,
	flushDiagnosticDelivery,
} from '../error-reporting/delivery';
import { sanitizeSentryEvent } from '../error-reporting/sanitize';

describe('uploaded voice messages', () => {
	it('keeps owned labels and safe context while excluding private strings, including runtime callers', async () => {
		const batches: TDiagnosticBatch[] = [];
		const previousMode = process.env.MODE;
		process.env.MODE = 'test';
		const consoleLog = spyOn(console, 'log').mockImplementation(() => {});
		configureDiagnosticDelivery(
			{
				createId: () => crypto.randomUUID(),
				upload: async (batch) => {
					batches.push(batch);
				},
			},
			'server:voice-privacy-test',
			true,
		);
		authenticateDiagnosticDelivery();
		try {
			logVoice('Producer transport connection state changed', 'private-extra-argument', {
				state: 'failed',
				transportId: 'transport-1',
				deviceLabel: 'private-device-label',
				error: new TypeError('private-error-message'),
			});
			Reflect.apply(logVoice, undefined, ['private-event-label', { attempt: 2 }]);
			Reflect.apply(recordVoiceDiagnostic, undefined, ['private-direct-label', [{ attempt: 3 }], 'warning']);
			await flushDiagnosticDelivery();
			const records = batches.flatMap((batch) => batch.records);
			expect(records).toHaveLength(3);
			expect(records.find((record) => record.message === 'Producer transport connection state changed')).toMatchObject({
				message: 'Producer transport connection state changed',
				context: { state: 'failed', transportId: 'transport-1', errorType: 'TypeError' },
			});
			expect(records.find((record) => record.context?.attempt === 2)).toMatchObject({
				message: 'Voice diagnostic',
				context: { attempt: 2 },
			});
			expect(records.find((record) => record.context?.attempt === 3)).toMatchObject({
				message: 'Voice diagnostic',
				level: 'warning',
				context: { attempt: 3 },
			});
			expect(JSON.stringify(records)).not.toContain('private-');
		} finally {
			clearDiagnosticDelivery();
			consoleLog.mockRestore();
			if (previousMode === undefined) delete process.env.MODE;
			else process.env.MODE = previousMode;
		}
	});
});

describe('reportError', () => {
	it('logs through the console reference captured before Sentry wraps it', async () => {
		const originalConsoleError = console.error;
		const preInitConsoleError = mock(() => {});
		const sentryWrappedConsoleError = mock(() => {});

		try {
			// Stands in for the real console.error that browser-logger binds at module
			// evaluation, before Sentry.init() installs captureConsoleIntegration.
			console.error = preInitConsoleError;
			// A fresh module instance: another test file may already have evaluated
			// browser-logger with the real console bound.
			const { reportError }: typeof import('../browser-logger') = await import(`../browser-logger?fresh=${Date.now()}`);

			// Sentry wraps console.error during init, i.e. after module evaluation.
			console.error = sentryWrappedConsoleError;
			reportError('Voice reconnect recovery gave up', undefined, { reason: 'reconnect-expired' });

			// Routing around the wrapper is what stops captureConsoleIntegration from
			// filing a second, differently-grouped issue for an already-reported error.
			expect(sentryWrappedConsoleError).not.toHaveBeenCalled();
			expect(preInitConsoleError).toHaveBeenCalledTimes(1);
		} finally {
			console.error = originalConsoleError;
		}
	});
});

describe('sanitizeSentryEvent', () => {
	it('removes sensitive request metadata and redacts identifiers', () => {
		const sanitized = sanitizeSentryEvent({
			message: 'Failed request for https://log.tycho.nz/servers/123456/channels/654321?token=secret',
			user: {
				id: '42',
				username: 'jono',
				email: 'jonoc@example.com',
			},
			request: {
				url: 'https://log.tycho.nz/servers/123456/channels/654321?token=secret',
				headers: {
					authorization: 'Bearer topsecret',
				},
				data: {
					content: 'hello world',
				},
				query_string: 'token=secret',
			},
			extra: {
				accessToken: 'topsecret',
				channelId: 654321,
				serverVersion: '1.2.3',
				channelName: '#general',
				nestedUrl: 'https://log.tycho.nz/invites/123456',
				payload: {
					channelId: 654321,
				},
			},
			contexts: {
				reported_error: {
					feature: 'settings',
					username: 'jono',
					nested: {
						ignored: true,
					},
				},
			},
			exception: {
				values: [
					{
						type: 'Error',
						value: 'Token failure for jonoc@example.com at https://log.tycho.nz/users/123456',
					},
				],
			},
		} satisfies Event);

		expect(sanitized.user).toEqual({ id: '42' });
		expect(sanitized.request?.headers).toBeUndefined();
		expect(sanitized.request?.data).toBeUndefined();
		expect(sanitized.request?.query_string).toBeUndefined();
		expect(sanitized.request?.url).toBe('https://log.tycho.nz/servers/[id]/channels/[id]');
		expect(sanitized.message).toContain('https://log.tycho.nz/servers/[id]/channels/[id]');
		expect(sanitized.extra).toEqual({
			accessToken: '[redacted]',
			channelId: 654321,
			serverVersion: '1.2.3',
			channelName: '#general',
			nestedUrl: 'https://log.tycho.nz/invites/[id]',
		});
		expect(sanitized.contexts).toEqual({
			reported_error: {
				feature: 'settings',
				username: 'jono',
			},
		});
		expect(sanitized.exception?.values?.[0]?.value).toBe(
			'Token failure for [redacted-email] at https://log.tycho.nz/users/[id]',
		);
	});
});
