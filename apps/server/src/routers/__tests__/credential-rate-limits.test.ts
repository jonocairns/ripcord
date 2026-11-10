import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';
import { TEST_SECRET_TOKEN } from '../../__tests__/seed';

describe('credential rate limits', () => {
	test('limits password checks per user without blocking another user', async () => {
		const { caller } = await initTest(1);
		const input = {
			currentPassword: 'wrong-password',
			newPassword: 'new-password',
			confirmNewPassword: 'new-password',
		};
		for (let i = 0; i < 10; i++) {
			await expect(caller.users.updatePassword(input)).rejects.toThrow('Current password is incorrect');
		}
		await expect(caller.users.updatePassword(input)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
		const { caller: other } = await initTest(2);
		await expect(other.users.updatePassword(input)).rejects.toThrow('Current password is incorrect');
	});

	for (const route of ['totpGenerateSetup', 'totpDisable', 'totpRegenerateRecoveryCodes'] as const) {
		test(`limits ${route} password checks per user`, async () => {
			const { caller } = await initTest(1);
			const input = { password: 'wrong-password', code: '123456' };
			for (let i = 0; i < 10; i++) {
				await expect(caller.users[route](input)).rejects.toThrow('Password is incorrect');
			}
			await expect(caller.users[route](input)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
			const { caller: other } = await initTest(2);
			await expect(other.users[route](input)).rejects.toThrow('Password is incorrect');
		});
	}

	test('shares one password-check budget across routes', async () => {
		const { caller } = await initTest(1);
		const passwordInput = {
			currentPassword: 'wrong-password',
			newPassword: 'new-password',
			confirmNewPassword: 'new-password',
		};
		for (let i = 0; i < 5; i++) {
			await expect(caller.users.updatePassword(passwordInput)).rejects.toThrow('Current password is incorrect');
			await expect(caller.users.totpDisable({ password: 'wrong-password', code: '123456' })).rejects.toThrow(
				'Password is incorrect',
			);
		}
		await expect(
			caller.users.totpRegenerateRecoveryCodes({ password: 'wrong-password', code: '123456' }),
		).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
	});

	test('rejects the sixth secret token attempt even when the token is correct', async () => {
		const { caller } = await initTest(2);
		for (let i = 0; i < 5; i++) {
			// biome-ignore lint/correctness/useHookAtTopLevel: This is a tRPC procedure, not a React hook.
			await expect(caller.others.useSecretToken({ token: 'wrong-token' })).rejects.toThrow('Invalid secret token');
		}
		await expect(caller.others.useSecretToken({ token: TEST_SECRET_TOKEN })).rejects.toMatchObject({
			code: 'TOO_MANY_REQUESTS',
		});
		const { caller: other } = await initTest(1);
		await expect(other.others.useSecretToken({ token: 'wrong-token' })).rejects.toThrow('Invalid secret token');
	});
});
