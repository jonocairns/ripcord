import { randomUUIDv7 } from 'bun';
import { sha256 } from '@sharkord/shared';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { getServerToken } from '../db/queries/server';
import { refreshTokens } from '../db/schema';

const ACCESS_TOKEN_EXPIRES_IN = '86400s'; // 1 day
const REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

const createAccessToken = async (userId: number) =>
  jwt.sign({ userId }, await getServerToken(), {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN
  });

const createRefreshTokenValue = () => `${randomUUIDv7()}.${randomUUIDv7()}`;

const issueAuthTokens = async (userId: number) => {
  const token = await createAccessToken(userId);
  const refreshToken = createRefreshTokenValue();
  const refreshTokenHash = await sha256(refreshToken);
  const now = Date.now();

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: refreshTokenHash,
    expiresAt: now + REFRESH_TOKEN_TTL_MS,
    createdAt: now,
    updatedAt: now
  });

  return { token, refreshToken };
};

export {
  REFRESH_TOKEN_TTL_MS,
  createAccessToken,
  createRefreshTokenValue,
  issueAuthTokens
};
