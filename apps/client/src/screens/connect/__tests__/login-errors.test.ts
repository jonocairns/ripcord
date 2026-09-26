import { describe, expect, test } from 'bun:test';
import { getLoginErrors } from '../login-errors';

describe('login errors', () => {
	test('preserves field validation errors', () => {
		expect(getLoginErrors({ errors: { password: 'Invalid password' } }, null)).toEqual({
			password: 'Invalid password',
		});
	});
	test('displays account and IP limits with the retry window', () => {
		expect(getLoginErrors({ error: 'Too many attempts.' }, '900')).toEqual({
			identity: 'Too many attempts. Try again in 15 minutes.',
		});
		expect(getLoginErrors({ errors: {}, error: 'Too many attempts.' }, '15').identity).toContain('1 minute');
	});
	test('handles malformed responses and retry values', () => {
		expect(getLoginErrors(null, null)).toEqual({ identity: 'Sign-in failed. Please try again.' });
		expect(getLoginErrors({ error: 'Try later' }, 'invalid')).toEqual({ identity: 'Try later' });
	});
});
