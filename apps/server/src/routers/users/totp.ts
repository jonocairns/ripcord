import { ActivityLogType } from '@sharkord/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db } from '../../db';
import { getServerToken, getSettings } from '../../db/queries/server';
import {
  getUserTotpData,
  isUserTotpEnabled,
  setUserTotpData,
  updateUserRecoveryCodes
} from '../../db/queries/totp';
import { refreshTokens, users } from '../../db/schema';
import { verifyPassword } from '../../helpers/password';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSetup,
  verifyAndConsumeTotpToken
} from '../../helpers/totp';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

// The setup flow is stateless: we encode the pending secret + recovery codes
// into a short-lived JWT (setupToken) so the client can send it back during
// confirmation without server-side session storage.

const SETUP_TOKEN_EXPIRES_IN = '10m';

const zSetupPayload = z.object({
  secret: z.string(),
  hashedCodes: z.array(z.string()),
  purpose: z.literal('totp-setup')
});

type TSetupPayload = z.infer<typeof zSetupPayload>;

const totpStatusRoute = protectedProcedure.query(async ({ ctx }) => {
  const enabled = await isUserTotpEnabled(ctx.userId);
  return { enabled };
});

const totpGenerateSetupRoute = protectedProcedure
  .input(
    z.object({
      password: z.string().min(1)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const user = await db
      .select({ password: users.password })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .get();

    invariant(user, { code: 'NOT_FOUND', message: 'User not found' });

    const passwordValid = await verifyPassword(input.password, user.password);

    if (!passwordValid) {
      return ctx.throwValidationError('password', 'Password is incorrect');
    }

    const settings = await getSettings();
    const { secret, qrCodeDataUrl } = await generateTotpSetup(
      ctx.user.identity,
      settings.name
    );
    const { plainCodes, hashedCodes } = await generateRecoveryCodes();

    const serverToken = await getServerToken();
    const setupToken = jwt.sign(
      { secret, hashedCodes, purpose: 'totp-setup' } satisfies TSetupPayload,
      serverToken,
      { expiresIn: SETUP_TOKEN_EXPIRES_IN }
    );

    return {
      setupToken,
      qrCodeDataUrl,
      secret, // base32 secret for manual entry
      recoveryCodes: plainCodes
    };
  });

const totpConfirmSetupRoute = protectedProcedure
  .input(
    z.object({
      setupToken: z.string().min(1),
      code: z.string().length(6)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const serverToken = await getServerToken();

    let payload: TSetupPayload;
    try {
      payload = zSetupPayload.parse(jwt.verify(input.setupToken, serverToken));
    } catch {
      return ctx.throwValidationError(
        'setupToken',
        'Setup session expired. Please start again.'
      );
    }

    const isValid = verifyAndConsumeTotpToken(
      ctx.userId,
      payload.secret,
      input.code
    );

    if (!isValid) {
      return ctx.throwValidationError(
        'code',
        'Invalid code. Make sure your authenticator app is synced and try again.'
      );
    }

    const encryptedSecret = await encryptTotpSecret(payload.secret);

    await setUserTotpData(
      ctx.userId,
      encryptedSecret,
      JSON.stringify(payload.hashedCodes)
    );

    enqueueActivityLog({
      type: ActivityLogType.USER_ENABLED_2FA,
      userId: ctx.userId
    });

    return { success: true };
  });

const totpDisableRoute = protectedProcedure
  .input(
    z.object({
      password: z.string().min(1),
      code: z.string().min(1).max(32)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const now = Date.now();

    const user = await db
      .select({ password: users.password })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .get();

    invariant(user, { code: 'NOT_FOUND', message: 'User not found' });

    const passwordValid = await verifyPassword(input.password, user.password);

    if (!passwordValid) {
      return ctx.throwValidationError('password', 'Password is incorrect');
    }

    const totpData = await getUserTotpData(ctx.userId);

    if (!totpData?.totpSecret) {
      return ctx.throwValidationError(
        'code',
        'Two-factor authentication is not enabled'
      );
    }

    const decryptedSecret = await decryptTotpSecret(totpData.totpSecret);
    const isValid = verifyAndConsumeTotpToken(
      ctx.userId,
      decryptedSecret,
      input.code
    );

    if (!isValid) {
      return ctx.throwValidationError('code', 'Invalid authentication code');
    }

    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          totpSecret: null,
          totpRecoveryCodes: null,
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: now
        })
        .where(eq(users.id, ctx.userId))
        .run();

      // Revoke all refresh tokens to force re-authentication
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(refreshTokens.userId, ctx.userId),
            isNull(refreshTokens.revokedAt)
          )
        )
        .run();
    });

    enqueueActivityLog({
      type: ActivityLogType.USER_DISABLED_2FA,
      userId: ctx.userId
    });

    return { success: true };
  });

const totpRegenerateRecoveryCodesRoute = protectedProcedure
  .input(
    z.object({
      password: z.string().min(1),
      code: z.string().length(6)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const user = await db
      .select({ password: users.password })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .get();

    invariant(user, { code: 'NOT_FOUND', message: 'User not found' });

    const passwordValid = await verifyPassword(input.password, user.password);

    if (!passwordValid) {
      return ctx.throwValidationError('password', 'Password is incorrect');
    }

    const totpData = await getUserTotpData(ctx.userId);

    if (!totpData?.totpSecret) {
      return ctx.throwValidationError(
        'code',
        'Two-factor authentication is not enabled'
      );
    }

    const decryptedSecret = await decryptTotpSecret(totpData.totpSecret);
    const isValid = verifyAndConsumeTotpToken(
      ctx.userId,
      decryptedSecret,
      input.code
    );

    if (!isValid) {
      return ctx.throwValidationError('code', 'Invalid authentication code');
    }

    const { plainCodes, hashedCodes } = await generateRecoveryCodes();

    await updateUserRecoveryCodes(ctx.userId, hashedCodes);

    enqueueActivityLog({
      type: ActivityLogType.USER_REGENERATED_RECOVERY_CODES,
      userId: ctx.userId
    });

    return { recoveryCodes: plainCodes };
  });

export {
  totpConfirmSetupRoute,
  totpDisableRoute,
  totpGenerateSetupRoute,
  totpRegenerateRecoveryCodesRoute,
  totpStatusRoute
};
