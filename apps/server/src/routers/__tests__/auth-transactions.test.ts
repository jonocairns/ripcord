import { describe, expect, spyOn, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { z } from 'zod';
import { initTest, login, refresh } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { users } from '../../db/schema';
import * as passwordHelpers from '../../helpers/password';
import { hashPassword, verifyPassword } from '../../helpers/password';
import { encryptTotpSecret } from '../../helpers/totp';

const createSession = async (identity = 'testuser') => {
	const response = await login(identity, 'password123');
	expect(response.status).toBe(200);
	return z.object({ refreshToken: z.string() }).parse(await response.json()).refreshToken;
};

const getCredentials = (userId: number) => {
	const user = tdb
		.select({
			password: users.password,
			mustChangePassword: users.mustChangePassword,
			tokenVersion: users.tokenVersion,
			totpSecret: users.totpSecret,
			totpRecoveryCodes: users.totpRecoveryCodes,
		})
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!user) throw new Error('Missing test user');
	return user;
};

const preventSessionRevocation = () => {
	tdb.run(
		sql.raw(`CREATE TRIGGER fail_revocation BEFORE UPDATE ON refresh_tokens
		BEGIN SELECT RAISE(ABORT, 'forced revocation failure'); END;`),
	);
};

const enableTotp = async () => {
	const secret = new Secret({ size: 20 });
	tdb
		.update(users)
		.set({
			totpSecret: await encryptTotpSecret(secret.base32),
			totpRecoveryCodes: JSON.stringify(['hashed-recovery-code']),
		})
		.where(eq(users.id, 2))
		.run();
	return new TOTP({ secret, period: 30, digits: 6 });
};

describe('atomic credential changes', () => {
	test('failed refresh insertion leaves the original token usable', async () => {
		const token = await createSession();
		tdb.run(
			sql.raw(`CREATE TRIGGER fail_rotation BEFORE INSERT ON refresh_tokens
			BEGIN SELECT RAISE(ABORT, 'forced rotation failure'); END;`),
		);

		const failed = await refresh(token);
		expect(failed.status).toBe(500);
		await failed.text();
		tdb.run(sql.raw('DROP TRIGGER fail_rotation'));

		const retried = await refresh(token);
		expect(retried.status).toBe(200);
		await retried.text();
	});

	test('failed password change rolls back password and token version', async () => {
		await createSession();
		const { caller } = await initTest(2);
		const before = getCredentials(2);
		preventSessionRevocation();

		await expect(
			caller.users.updatePassword({
				currentPassword: 'password123',
				newPassword: 'newpassword123',
				confirmNewPassword: 'newpassword123',
			}),
		).rejects.toThrow('forced revocation failure');

		const after = getCredentials(2);
		expect(after).toEqual(before);
		expect(await verifyPassword('password123', after.password)).toBe(true);
	});

	test('a password changed during hashing is preserved and reported as a conflict', async () => {
		const { caller } = await initTest(2);
		const replacementHash = await hashPassword('other-session-password');
		const originalHashPassword = passwordHelpers.hashPassword;
		const hashSpy = spyOn(passwordHelpers, 'hashPassword').mockImplementation(async (password) => {
			const hash = await originalHashPassword(password);
			tdb.update(users).set({ password: replacementHash }).where(eq(users.id, 2)).run();
			return hash;
		});

		try {
			await expect(
				caller.users.updatePassword({
					currentPassword: 'password123',
					newPassword: 'newpassword123',
					confirmNewPassword: 'newpassword123',
				}),
			).rejects.toMatchObject({
				code: 'CONFLICT',
				message: 'Your password was changed in another session. Please try again.',
			});
			expect(getCredentials(2).password).toBe(replacementHash);
			expect(getCredentials(2).tokenVersion).toBe(0);
		} finally {
			hashSpy.mockRestore();
		}
	});

	test('incorrect current password is reported before mismatched confirmation', async () => {
		const { caller } = await initTest(2);
		await expect(
			caller.users.updatePassword({
				currentPassword: 'wrong-password',
				newPassword: 'newpassword123',
				confirmNewPassword: 'different-password',
			}),
		).rejects.toThrow('Current password is incorrect');
	});

	test('failed owner password reset rolls back password and token version', async () => {
		await createSession();
		const { caller } = await initTest(1);
		const before = getCredentials(2);
		preventSessionRevocation();

		await expect(caller.users.resetPassword({ userId: 2, newPassword: 'newpassword123' })).rejects.toThrow(
			'forced revocation failure',
		);

		const after = getCredentials(2);
		expect(after).toEqual(before);
		expect(await verifyPassword('password123', after.password)).toBe(true);
	});

	test('failed owner TOTP reset rolls back TOTP credentials and token version', async () => {
		await createSession();
		await enableTotp();
		const { caller } = await initTest(1);
		const before = getCredentials(2);
		preventSessionRevocation();

		await expect(caller.users.resetTotp({ userId: 2 })).rejects.toThrow('forced revocation failure');

		expect(getCredentials(2)).toEqual(before);
	});

	test('failed TOTP disable rolls back TOTP credentials and token version', async () => {
		await createSession();
		const totp = await enableTotp();
		const { caller } = await initTest(2);
		const before = getCredentials(2);
		preventSessionRevocation();

		await expect(caller.users.totpDisable({ password: 'password123', code: totp.generate() })).rejects.toThrow(
			'forced revocation failure',
		);

		expect(getCredentials(2)).toEqual(before);
	});
});
