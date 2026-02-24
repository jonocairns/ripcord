import crypto from 'crypto';
import { getServerTokenSync } from '../db/queries/server';

const FILE_ACCESS_TOKEN_TTL_MS = 1000 * 60 * 15;

const generateFileToken = (
  fileId: number,
  channelAccessToken: string,
  now: number = Date.now()
): string => {
  const expiresAt = now + FILE_ACCESS_TOKEN_TTL_MS;
  const hmac = crypto.createHmac('sha256', getServerTokenSync());

  hmac.update(`${fileId}:${channelAccessToken}:${expiresAt}`);

  const signature = hmac.digest('hex');

  return `${expiresAt}.${signature}`;
};

const verifyFileToken = (
  fileId: number,
  channelAccessToken: string,
  providedToken: string,
  now: number = Date.now()
): boolean => {
  const [expiresAtRaw, providedSignature] = providedToken.split('.', 2);

  if (!expiresAtRaw || !providedSignature) {
    return false;
  }

  const expiresAt = Number(expiresAtRaw);

  if (!Number.isInteger(expiresAt) || expiresAt <= now) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', getServerTokenSync());
  hmac.update(`${fileId}:${channelAccessToken}:${expiresAt}`);
  const expectedSignature = hmac.digest('hex');

  if (expectedSignature.length !== providedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(providedSignature)
  );
};

export { FILE_ACCESS_TOKEN_TTL_MS, generateFileToken, verifyFileToken };
