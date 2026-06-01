import { describe, expect, test } from 'bun:test';
import { TRPCClientError } from '@trpc/client';
import { getTrpcError, parseTrpcErrors } from '../parse-trpc-errors';

describe('parseTrpcErrors', () => {
	test('parses tRPC validation issue arrays into field errors', () => {
		const error = new TRPCClientError(
			JSON.stringify([
				{
					code: 'too_small',
					path: ['name'],
					message: 'Name is required',
				},
				{
					code: 'custom',
					path: [],
					message: 'Server settings are invalid',
				},
			]),
		);

		expect(parseTrpcErrors(error)).toEqual({
			name: 'Name is required',
			_general: 'Server settings are invalid',
		});
	});

	test('preserves plain field-error maps from non-tRPC callers', () => {
		expect(
			parseTrpcErrors({
				identity: 'Identity is required',
				password: undefined,
				ignored: 123,
			}),
		).toEqual({
			identity: 'Identity is required',
			password: undefined,
		});
	});

	test('falls back for plain objects without string or undefined field errors', () => {
		expect(
			parseTrpcErrors({
				code: 42,
				retriable: false,
			}),
		).toEqual({
			_general: 'Something went wrong, please try again.',
		});
	});

	test('falls back cleanly for unexpected error shapes', () => {
		expect(parseTrpcErrors(null)).toEqual({
			_general: 'Something went wrong, please try again.',
		});
		expect(parseTrpcErrors(['not', 'a', 'field map'])).toEqual({
			_general: 'Something went wrong, please try again.',
		});
		expect(parseTrpcErrors(new Error('Plain failure'))).toEqual({
			_general: 'Plain failure',
		});
		expect(parseTrpcErrors(new TRPCClientError('Not JSON'))).toEqual({
			_general: 'Not JSON',
		});
	});
});

describe('getTrpcError', () => {
	test('returns useful messages for tRPC and regular errors', () => {
		expect(getTrpcError(new TRPCClientError('TRPC failure'), 'Fallback')).toBe('TRPC failure');
		expect(getTrpcError(new Error('Regular failure'), 'Fallback')).toBe('Regular failure');
		expect(getTrpcError('bad shape', 'Fallback')).toBe('Fallback');
	});
});
