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

const zBody = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required')
});

const refreshRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const { refreshToken } = zBody.parse(await getJsonBody(req));
  const refreshTokenHash = await sha256(refreshToken);
  const now = Date.now();
  const newRefreshToken = createRefreshTokenValue();
  const newRefreshTokenHash = await sha256(newRefreshToken);

  const rotationResult = await db.transaction(async (tx) => {
    const existingSession = await tx
      .update(refreshTokens)
      .set({
        revokedAt: now,
        updatedAt: now
      })
      .where(
        and(
          eq(refreshTokens.tokenHash, refreshTokenHash),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, now)
        )
      )
      .returning({
        id: refreshTokens.id,
        userId: refreshTokens.userId
      })
      .get();

    if (!existingSession) {
      return { status: 'invalid' as const };
    }

    const user = await tx
      .select({
        id: users.id,
        banned: users.banned
      })
      .from(users)
      .where(eq(users.id, existingSession.userId))
      .get();

    if (!user || user.banned) {
      return { status: 'unauthorized' as const };
    }

    await tx.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: newRefreshTokenHash,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      createdAt: now,
      updatedAt: now
    });

    await tx
      .update(refreshTokens)
      .set({
        replacedByTokenHash: newRefreshTokenHash,
        updatedAt: now
      })
      .where(eq(refreshTokens.id, existingSession.id))
      .run();

    return { status: 'ok' as const, userId: user.id };
  });

  if (rotationResult.status === 'invalid') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid refresh token' }));
    return;
  }

  if (rotationResult.status === 'unauthorized') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const token = await createAccessToken(rotationResult.userId);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({ success: true, token, refreshToken: newRefreshToken })
  );
};

export { refreshRouteHandler };
