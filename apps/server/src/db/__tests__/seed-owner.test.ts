import { describe, expect, spyOn, test } from 'bun:test';
import { sha256 } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { tdb } from '../../__tests__/setup';
import { hashPassword, verifyPassword } from '../../helpers/password';
import { logger } from '../../logger';
import { logins, refreshTokens, users } from '../schema';
import { rotateDefaultSeedOwnerPassword } from '../seed-owner';

const getOwner = () => {
	const user = tdb.select().from(users).where(eq(users.id, 1)).get();
	if (!user) throw new Error('Missing seed owner');
	return user;
};

const insertRefreshToken = (userId: number) =>
	tdb
		.insert(refreshTokens)
		.values({ userId, tokenHash: `token-${userId}`, expiresAt: Date.now() + 60_000, createdAt: Date.now() })
		.run();

// Default password, no sign-in history for user 1; user 2 has a session that
// rotation must leave alone.
const prepareDefaultOwner = async (legacy: boolean) => {
	const owner = getOwner();
	tdb
		.update(users)
		.set({
			password: legacy ? await sha256('ripcord') : await hashPassword('ripcord'),
			tokenVersion: 4,
			lastLoginAt: owner.createdAt,
		})
		.where(eq(users.id, 1))
		.run();
	tdb.delete(logins).where(eq(logins.userId, 1)).run();
	insertRefreshToken(2);
};

const captureStdout = () => spyOn(process.stdout, 'write').mockImplementation(() => true);

const expectRotatedWithPrintedCredentials = async (stdout: ReturnType<typeof captureStdout>) => {
	const user = getOwner();
	expect(user.mustChangePassword).toBe(true);
	expect(user.tokenVersion).toBe(5);
	expect(await verifyPassword('ripcord', user.password)).toBe(false);
	expect(stdout).toHaveBeenCalledTimes(1);
	const notice = String(stdout.mock.calls[0]?.[0]);
	expect(notice).toContain('has sign-in history');
	expect(notice).toContain(`Identity: ${user.identity} `);
	const password = /New password: (\S+)/.exec(notice)?.[1];
	if (!password) throw new Error('Missing replacement password');
	expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(await verifyPassword(password, user.password)).toBe(true);
	return user;
};

describe('production seed owner password rotation', () => {
	for (const legacy of [false, true]) {
		test(`rotates ${legacy ? 'legacy' : 'argon2'} defaults without printing unused account credentials`, async () => {
			await prepareDefaultOwner(legacy);
			const stdout = captureStdout();
			const warn = spyOn(logger, 'warn');
			try {
				await rotateDefaultSeedOwnerPassword({ isProduction: true });
				const user = getOwner();
				expect(await verifyPassword('ripcord', user.password)).toBe(false);
				expect(user.tokenVersion).toBe(5);
				expect(user.mustChangePassword).toBe(false);
				expect(tdb.select().from(refreshTokens).where(eq(refreshTokens.userId, 2)).get()?.revokedAt).toBeNull();
				expect(stdout).not.toHaveBeenCalled();
				expect(warn).toHaveBeenCalledTimes(1);
				expect(JSON.stringify(warn.mock.calls)).not.toContain(user.identity);
			} finally {
				stdout.mockRestore();
				warn.mockRestore();
			}
		});
	}

	test('prints usable credentials once and revokes sessions for an account with a login record', async () => {
		await prepareDefaultOwner(false);
		tdb.insert(logins).values({ userId: 1, createdAt: Date.now() }).run();
		insertRefreshToken(1);
		const stdout = captureStdout();
		try {
			await rotateDefaultSeedOwnerPassword({ isProduction: true });
			const user = await expectRotatedWithPrintedCredentials(stdout);
			expect(tdb.select().from(refreshTokens).where(eq(refreshTokens.userId, 1)).get()?.revokedAt).toBeNumber();
			expect(tdb.select().from(refreshTokens).where(eq(refreshTokens.userId, 2)).get()?.revokedAt).toBeNull();
			await rotateDefaultSeedOwnerPassword({ isProduction: true });
			expect(stdout).toHaveBeenCalledTimes(1);
			expect(getOwner()).toEqual(user);
		} finally {
			stdout.mockRestore();
		}
	});

	test('treats a refresh token as sign-in history when no login record was written', async () => {
		await prepareDefaultOwner(false);
		insertRefreshToken(1);
		const stdout = captureStdout();
		try {
			await rotateDefaultSeedOwnerPassword({ isProduction: true });
			await expectRotatedWithPrintedCredentials(stdout);
		} finally {
			stdout.mockRestore();
		}
	});

	test('treats a join long after creation as sign-in history when no login record was written', async () => {
		await prepareDefaultOwner(false);
		const owner = getOwner();
		tdb
			.update(users)
			.set({ lastLoginAt: owner.createdAt + 5 * 60_000 })
			.where(eq(users.id, 1))
			.run();
		const stdout = captureStdout();
		try {
			await rotateDefaultSeedOwnerPassword({ isProduction: true });
			await expectRotatedWithPrintedCredentials(stdout);
		} finally {
			stdout.mockRestore();
		}
	});

	test('skips rotation instead of failing boot when the stored hash is malformed', async () => {
		tdb.update(users).set({ password: '$argon2id$not-a-real-hash' }).where(eq(users.id, 1)).run();
		const before = getOwner();
		await rotateDefaultSeedOwnerPassword({ isProduction: true });
		expect(getOwner()).toEqual(before);
	});

	test('leaves a changed password and sessions alone', async () => {
		const before = getOwner();
		await rotateDefaultSeedOwnerPassword({ isProduction: true });
		expect(getOwner()).toEqual(before);
	});

	test('leaves development credentials and sessions alone', async () => {
		await prepareDefaultOwner(false);
		const before = getOwner();
		const tokens = tdb.select().from(refreshTokens).all();
		await rotateDefaultSeedOwnerPassword({ isProduction: false });
		expect(getOwner()).toEqual(before);
		expect(tdb.select().from(refreshTokens).all()).toEqual(tokens);
	});

	test('does nothing when user 1 is missing', async () => {
		tdb.delete(users).where(eq(users.id, 1)).run();
		await rotateDefaultSeedOwnerPassword({ isProduction: true });
		expect(tdb.select().from(users).where(eq(users.id, 1)).get()).toBeUndefined();
	});
});
