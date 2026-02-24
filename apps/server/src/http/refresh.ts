import { sha256 } from '@sharkord/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import http from 'http';
import z from 'zod';
import { db } from '../db';
import { refreshTokens, users } from '../db/schema';
import {
  REFRESH_TOKEN_TTL_MS,
  createAccessToken,
  createRefreshTokenValue
} from './auth-tokens';
import { getJsonBody } from './helpers';

const REFRESH_JSON_BODY_MAX_BYTES = 8 * 1024;
const REFRESH_TOKEN_RACE_ERROR = 'REFRESH_TOKEN_ALREADY_ROTATED';

const zBody = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required')
});

const refreshRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const { refreshToken } = zBody.parse(
    await getJsonBody(req, { maxBytes: REFRESH_JSON_BODY_MAX_BYTES })
  );
  const refreshTokenHash = await sha256(refreshToken);
  const now = Date.now();

  const existingSession = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, refreshTokenHash))
    .get();

  if (
    !existingSession ||
    existingSession.revokedAt ||
    existingSession.expiresAt <= now
  ) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid refresh token' }));
    return;
  }

  const user = await db
    .select({
      id: users.id,
      banned: users.banned
    })
    .from(users)
    .where(eq(users.id, existingSession.userId))
    .get();

  if (!user || user.banned) {
    await db
      .update(refreshTokens)
      .set({
        revokedAt: now,
        updatedAt: now
      })
      .where(eq(refreshTokens.id, existingSession.id))
      .run();

    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const token = await createAccessToken(user.id);
  const newRefreshToken = createRefreshTokenValue();
  const newRefreshTokenHash = await sha256(newRefreshToken);

  try {
    await db.transaction(async (tx) => {
      const revokedSession = await tx
        .update(refreshTokens)
        .set({
          revokedAt: now,
          replacedByTokenHash: newRefreshTokenHash,
          updatedAt: now
        })
        .where(
          and(
            eq(refreshTokens.id, existingSession.id),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, now)
          )
        )
        .returning({ id: refreshTokens.id })
        .get();

      if (!revokedSession) {
        throw new Error(REFRESH_TOKEN_RACE_ERROR);
      }

      await tx.insert(refreshTokens).values({
        userId: user.id,
        tokenHash: newRefreshTokenHash,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        createdAt: now,
        updatedAt: now
      });
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === REFRESH_TOKEN_RACE_ERROR
    ) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid refresh token' }));
      return;
    }

    throw error;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({ success: true, token, refreshToken: newRefreshToken })
  );
};

export { refreshRouteHandler };
