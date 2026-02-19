import { sha256 } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
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

  await db.transaction(async (tx) => {
    await tx
      .update(refreshTokens)
      .set({
        revokedAt: now,
        replacedByTokenHash: newRefreshTokenHash,
        updatedAt: now
      })
      .where(eq(refreshTokens.id, existingSession.id))
      .run();

    await tx.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: newRefreshTokenHash,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      createdAt: now,
      updatedAt: now
    });
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({ success: true, token, refreshToken: newRefreshToken })
  );
};

export { refreshRouteHandler };
