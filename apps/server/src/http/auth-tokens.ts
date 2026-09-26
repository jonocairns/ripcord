import { sha256 } from '@sharkord/shared';
import { randomUUIDv7 } from 'bun';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { getServerToken } from '../db/queries/server';
import { refreshTokens, users } from '../db/schema';
import { invariant } from '../utils/invariant';

const ACCESS_TOKEN_EXPIRES_IN = '86400s'; // 1 day
const REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
// Leeway for benign refresh races (double-submit, network retry, multiple tabs):
// replaying a token revoked within this window is rejected but does NOT trigger
// family revocation, so a legitimate race never logs the user out.
const REFRESH_REUSE_GRACE_MS = 10 * 1000; // 10 seconds

const createAccessToken = async (userId: number, tokenVersion: number) =>
	jwt.sign({ userId, tokenVersion }, await getServerToken(), {
		expiresIn: ACCESS_TOKEN_EXPIRES_IN,
	});

const createRefreshTokenValue = () => `${randomUUIDv7()}.${randomUUIDv7()}`;

const issueAuthTokens = async (userId: number, tokenVersion: number) => {
	const token = await createAccessToken(userId, tokenVersion);
	const refreshToken = createRefreshTokenValue();
	const refreshTokenHash = await sha256(refreshToken);
	const now = Date.now();

	// Token signing/hashing can yield while a credential change revokes sessions.
	// Recheck the version and insert synchronously in the same SQLite transaction.
	db.transaction((tx) => {
		const user = tx
			.select({ tokenVersion: users.tokenVersion, banned: users.banned })
			.from(users)
			.where(eq(users.id, userId))
			.get();
		invariant(user && !user.banned && user.tokenVersion === tokenVersion, {
			code: 'UNAUTHORIZED',
			message: 'Your session is no longer valid. Please sign in again.',
		});
		tx.insert(refreshTokens)
			.values({
				userId,
				tokenHash: refreshTokenHash,
				expiresAt: now + REFRESH_TOKEN_TTL_MS,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	});

	return { token, refreshToken };
};

export { createAccessToken, createRefreshTokenValue, issueAuthTokens, REFRESH_REUSE_GRACE_MS, REFRESH_TOKEN_TTL_MS };
