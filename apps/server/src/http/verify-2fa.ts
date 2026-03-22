import { ActivityLogType } from '@sharkord/shared';
import type http from 'node:http';
import z from 'zod';
import { getUserTotpData, updateUserRecoveryCodes } from '../db/queries/totp';
import { getUserById } from '../db/queries/users';
import {
  decryptTotpSecret,
  verifyChallengeToken,
  verifyRecoveryCode,
  verifyTotpToken
} from '../helpers/totp';
import { enqueueActivityLog } from '../queues/activity-log';
import { issueAuthTokens } from './auth-tokens';
import { getJsonBody } from './helpers';
import { HttpValidationError } from './utils';

const AUTH_REQUEST_MAX_BODY_BYTES = 8 * 1024;

const zBody = z.object({
  challengeToken: z.string().min(1),
  code: z.string().min(1).max(32),
  isRecoveryCode: z.boolean().optional()
});

const verify2faRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const data = zBody.parse(
    await getJsonBody(req, { maxBytes: AUTH_REQUEST_MAX_BODY_BYTES })
  );

  const challenge = await verifyChallengeToken(data.challengeToken);

  if (!challenge) {
    throw new HttpValidationError(
      'challengeToken',
      'Invalid or expired challenge token. Please log in again.'
    );
  }

  const user = await getUserById(challenge.userId);

  if (!user) {
    throw new HttpValidationError('challengeToken', 'User not found');
  }

  const totpData = await getUserTotpData(user.id);

  if (!totpData?.totpSecret) {
    throw new HttpValidationError(
      'code',
      'Two-factor authentication is not enabled for this account'
    );
  }

  const decryptedSecret = await decryptTotpSecret(totpData.totpSecret);

  if (data.isRecoveryCode) {
    const storedCodes: string[] = totpData.totpRecoveryCodes
      ? JSON.parse(totpData.totpRecoveryCodes)
      : [];

    const { valid, remainingCodes } = await verifyRecoveryCode(
      data.code,
      storedCodes
    );

    if (!valid) {
      throw new HttpValidationError('code', 'Invalid recovery code');
    }

    await updateUserRecoveryCodes(user.id, remainingCodes);

    enqueueActivityLog({
      type: ActivityLogType.USER_USED_RECOVERY_CODE,
      userId: user.id,
      details: { remainingCodes: remainingCodes.length }
    });
  } else {
    const isValid = verifyTotpToken(decryptedSecret, data.code);

    if (!isValid) {
      throw new HttpValidationError('code', 'Invalid authentication code');
    }
  }

  const { token, refreshToken } = await issueAuthTokens(
    user.id,
    user.tokenVersion
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, token, refreshToken }));

  return res;
};

export { verify2faRouteHandler };
