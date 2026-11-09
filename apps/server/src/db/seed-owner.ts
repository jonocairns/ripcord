import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../helpers/password';
import { logger } from '../logger';
import { IS_PRODUCTION } from '../utils/env';
import { db } from './index';
import { logins, refreshTokens, users } from './schema';

// lastLoginAt defaults to the insert time, so only a join well after the
// account was created counts as use.
const SIGN_IN_HISTORY_GRACE_MS = 60_000;

const rotateDefaultSeedOwnerPassword = async (options?: { isProduction?: boolean }) => {
	if (!(options?.isProduction ?? IS_PRODUCTION)) return;

	const user = db.select().from(users).where(eq(users.id, 1)).get();
	if (!user) return;

	let hasDefaultPassword = false;
	try {
		hasDefaultPassword = await verifyPassword('ripcord', user.password);
	} catch (error) {
		// A malformed stored hash must not stop the server from booting.
		logger.warn('Could not check the seed owner account (user 1) password; skipping rotation.', error);
		return;
	}
	if (!hasDefaultPassword) return;

	const password = randomBytes(32).toString('base64url');
	const hashedPassword = await hashPassword(password);
	const now = Date.now();

	const hasLoginHistory = db.transaction((tx) => {
		// Login rows are written asynchronously after an ipinfo.io lookup and can
		// be missing on servers without internet access, so also treat a later
		// join (lastLoginAt) or any issued refresh token as sign-in history.
		const hasLogins =
			tx.select({ id: logins.id }).from(logins).where(eq(logins.userId, 1)).limit(1).get() !== undefined ||
			tx.select({ id: refreshTokens.id }).from(refreshTokens).where(eq(refreshTokens.userId, 1)).limit(1).get() !==
				undefined ||
			user.lastLoginAt > user.createdAt + SIGN_IN_HISTORY_GRACE_MS;
		tx.update(users)
			.set({
				password: hashedPassword,
				tokenVersion: sql`${users.tokenVersion} + 1`,
				...(hasLogins ? { mustChangePassword: true } : {}),
			})
			.where(eq(users.id, 1))
			.run();
		tx.update(refreshTokens)
			.set({ revokedAt: now, updatedAt: now })
			.where(and(eq(refreshTokens.userId, 1), isNull(refreshTokens.revokedAt)))
			.run();
		return hasLogins;
	});

	logger.warn('Seed owner account (user 1) default password was rotated; existing sessions were revoked.');
	if (hasLoginHistory) {
		// Write straight to stdout: console.log is recorded as a Sentry breadcrumb
		// and would ship these credentials with the next reported error.
		process.stdout.write(
			`Seed owner account (user 1) had the default password and has sign-in history. Review this account and its activity. Identity: ${user.identity} New password: ${password} You must change this password after signing in. These credentials will not be shown again.\n`,
		);
	}
};

export { rotateDefaultSeedOwnerPassword };
