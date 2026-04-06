import { describe, expect, it } from 'bun:test';
import type { Event } from '@sentry/browser';
import { sanitizeSentryEvent } from '../error-reporting/sanitize';

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

		expect(sanitized.user).toBeUndefined();
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
