import { describe, expect, it } from 'bun:test';
import {
	VoiceReconnectTimeoutError,
	classifyVoiceReconnectError,
	getVoiceReconnectRetryDelayMs,
} from '../reconnect-policy';

describe('voice reconnect policy', () => {
	describe('classifyVoiceReconnectError', () => {
		it('treats BAD_REQUEST, UNAUTHORIZED, FORBIDDEN, and NOT_FOUND as terminal', () => {
			for (const code of ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'] as const) {
				expect(
					classifyVoiceReconnectError(
						{
							data: {
								code,
								httpStatus: 400,
							},
						},
						{ consecutiveUnknownErrors: 0 },
					),
				).toEqual({
					kind: 'terminal',
					reason:
						code === 'BAD_REQUEST'
							? 'bad-request'
							: code === 'UNAUTHORIZED'
								? 'unauthorized'
								: code === 'FORBIDDEN'
									? 'forbidden'
									: 'not-found',
					clearReason: 'restore-terminal-error',
				});
			}
		});

		it('treats CONFLICT restore outcomes as terminal', () => {
			expect(
				classifyVoiceReconnectError(
					{
						data: {
							code: 'CONFLICT',
							httpStatus: 409,
						},
					},
					{ consecutiveUnknownErrors: 0 },
				),
			).toEqual({
				kind: 'terminal',
				reason: 'restore-conflict',
				clearReason: 'restore-conflict',
			});
		});

		it('treats plain HTTP 429 responses as retryable', () => {
			expect(
				classifyVoiceReconnectError(
					{
						data: {
							httpStatus: 429,
						},
					},
					{ consecutiveUnknownErrors: 0 },
				),
			).toEqual({
				kind: 'retry',
				reason: 'rate-limited',
				countsAsUnknown: false,
			});
		});

		it('treats TOO_MANY_REQUESTS as retryable', () => {
			expect(
				classifyVoiceReconnectError(
					{
						data: {
							code: 'TOO_MANY_REQUESTS',
							httpStatus: 429,
						},
					},
					{ consecutiveUnknownErrors: 0 },
				),
			).toEqual({
				kind: 'retry',
				reason: 'rate-limited',
				countsAsUnknown: false,
			});
		});

		it('treats 5xx responses as retryable', () => {
			expect(
				classifyVoiceReconnectError(
					{
						data: {
							code: 'INTERNAL_SERVER_ERROR',
							httpStatus: 500,
						},
					},
					{ consecutiveUnknownErrors: 0 },
				),
			).toEqual({
				kind: 'retry',
				reason: 'server-error',
				countsAsUnknown: false,
			});
		});

		it('treats network-like errors as retryable', () => {
			expect(
				classifyVoiceReconnectError(new Error('WebSocket closed while reconnecting'), {
					consecutiveUnknownErrors: 0,
				}),
			).toEqual({
				kind: 'retry',
				reason: 'network-error',
				countsAsUnknown: false,
			});
		});

		it('treats timeout sentinels as retryable', () => {
			expect(classifyVoiceReconnectError(new VoiceReconnectTimeoutError(), { consecutiveUnknownErrors: 0 })).toEqual({
				kind: 'retry',
				reason: 'timeout',
				countsAsUnknown: false,
			});
		});

		it('treats websocket close 1013 as retryable', () => {
			expect(
				classifyVoiceReconnectError(
					{
						closeCode: 1013,
					},
					{ consecutiveUnknownErrors: 0 },
				),
			).toEqual({
				kind: 'retry',
				reason: 'ws-1013',
				countsAsUnknown: false,
			});
		});

		it('caps unknown errors after three consecutive attempts', () => {
			expect(classifyVoiceReconnectError(new Error('mystery failure'), { consecutiveUnknownErrors: 2 })).toEqual({
				kind: 'terminal',
				reason: 'unknown-error-cap',
				clearReason: 'restore-terminal-error',
			});
		});

		it('treats unsupported codec/device load failures as terminal', () => {
			expect(
				classifyVoiceReconnectError(new Error('UnsupportedError: media codec not supported'), {
					consecutiveUnknownErrors: 0,
				}),
			).toEqual({
				kind: 'terminal',
				reason: 'unsupported-device',
				clearReason: 'restore-terminal-error',
			});
		});

		it('treats unknown errors below the cap as retryable', () => {
			expect(classifyVoiceReconnectError(new Error('mystery failure'), { consecutiveUnknownErrors: 0 })).toEqual({
				kind: 'retry',
				reason: 'unknown-error',
				countsAsUnknown: true,
			});
		});
	});

	describe('getVoiceReconnectRetryDelayMs', () => {
		it('uses the documented backoff sequence before jitter', () => {
			expect(getVoiceReconnectRetryDelayMs(0, 0.5)).toBe(1_000);
			expect(getVoiceReconnectRetryDelayMs(1, 0.5)).toBe(2_000);
			expect(getVoiceReconnectRetryDelayMs(2, 0.5)).toBe(4_000);
			expect(getVoiceReconnectRetryDelayMs(3, 0.5)).toBe(8_000);
			expect(getVoiceReconnectRetryDelayMs(4, 0.5)).toBe(10_000);
			expect(getVoiceReconnectRetryDelayMs(8, 0.5)).toBe(10_000);
		});

		it('applies plus-or-minus twenty percent jitter', () => {
			expect(getVoiceReconnectRetryDelayMs(0, 0)).toBe(800);
			expect(getVoiceReconnectRetryDelayMs(0, 1)).toBe(1_200);
		});
	});
});
