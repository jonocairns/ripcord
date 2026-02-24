import { sha256 } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import http from 'http';
import z from 'zod';
import { db } from '../db';
import { refreshTokens } from '../db/schema';
import { getJsonBody } from './helpers';

const LOGOUT_JSON_BODY_MAX_BYTES = 8 * 1024;

const zBody = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required')
});

const logoutRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const { refreshToken } = zBody.parse(
    await getJsonBody(req, { maxBytes: LOGOUT_JSON_BODY_MAX_BYTES })
  );
  const refreshTokenHash = await sha256(refreshToken);
  const now = Date.now();

  await db
    .update(refreshTokens)
    .set({
      revokedAt: now,
      updatedAt: now
    })
    .where(eq(refreshTokens.tokenHash, refreshTokenHash))
    .run();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
};

export { logoutRouteHandler };
