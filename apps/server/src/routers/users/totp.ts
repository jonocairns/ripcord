import { ActivityLogType, DisconnectCode } from '@sharkord/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db } from '../../db';
import { getServerToken, getSettings } from '../../db/queries/server';
import { getUserTotpData, isUserTotpEnabled, updateUserRecoveryCodes } from '../../db/queries/totp';
import { refreshTokens, users } from '../../db/schema';
import { verifyPassword } from '../../helpers/password';
import {
	decryptTotpSecret,
	encryptTotpSecret,
	generateRecoveryCodes,
	generateTotpSetup,
	verifyAndConsumeTotpToken,
} from '../../helpers/totp';
import { issueAuthTokens } from '../../http/auth-tokens';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { revokeOtherUserSessions, revokeUserSessions } from '../../utils/user-sessions';
import { blockVoiceRestoreAfterKick, getVoiceKickGuardIdentity } from '../../utils/voice-kick-guard';

// The setup flow is stateless: we encode the pending secret + recovery codes
// into a short-lived JWT (setupToken) so the client can send it back during
// confirmation without server-side session storage.

const SETUP_TOKEN_EXPIRES_IN = '10m';

const zSetupPayload = z.object({
	userId: z.number(),
	secret: z.string(),
	hashedCodes: z.array(z.string()),
	purpose: z.literal('totp-setup'),
});

type TSetupPayload = z.infer<typeof zSetupPayload>;

// Enabling or disabling 2FA changes what a sign-in requires, so every existing
// token (access and refresh) is invalidated in the same transaction.
const rotateUserTotp = async (userId: number, totpSecret: string | null, totpRecoveryCodes: string | null) => {
	const now = Date.now();

	return db.transaction(async (tx) => {
		const updatedUser = await tx
			.update(users)
			.set({
				totpSecret,
				totpRecoveryCodes,
				tokenVersion: sql`${users.tokenVersion} + 1`,
				updatedAt: now,
			})
			.where(eq(users.id, userId))
			.returning({ tokenVersion: users.tokenVersion })
			.get();

		await tx
			.update(refreshTokens)
			.set({ revokedAt: now, updatedAt: now })
			.where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
			.run();

		return updatedUser.tokenVersion;
	});
};

const totpStatusRoute = protectedProcedure.query(async ({ ctx }) => {
	const enabled = await isUserTotpEnabled(ctx.userId);
	return { enabled };
});

const totpGenerateSetupRoute = protectedProcedure
	.input(
		z.object({
			password: z.string().min(1),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		const user = await db.select({ password: users.password }).from(users).where(eq(users.id, ctx.userId)).get();

		invariant(user, { code: 'NOT_FOUND', message: 'User not found' });

		const passwordValid = await verifyPassword(input.password, user.password);

		if (!passwordValid) {
			return ctx.throwValidationError('password', 'Password is incorrect');
		}

		const settings = await getSettings();
		const { secret, qrCodeDataUrl } = await generateTotpSetup(ctx.user.identity, settings.name);
		const { plainCodes, hashedCodes } = await generateRecoveryCodes();

		const serverToken = await getServerToken();
		const setupToken = jwt.sign(
			{
				userId: ctx.userId,
				secret,
				hashedCodes,
				purpose: 'totp-setup',
			} satisfies TSetupPayload,
			serverToken,
			{ expiresIn: SETUP_TOKEN_EXPIRES_IN },
		);

		return {
			setupToken,
			qrCodeDataUrl,
			secret, // base32 secret for manual entry
			recoveryCodes: plainCodes,
		};
	});

const totpConfirmSetupRoute = protectedProcedure
	.input(
		z.object({
			setupToken: z.string().min(1),
			code: z.string().length(6),
			renewSession: z.boolean().optional(),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		const serverToken = await getServerToken();

		let payload: TSetupPayload;
		try {
			payload = zSetupPayload.parse(jwt.verify(input.setupToken, serverToken));
		} catch {
			return ctx.throwValidationError('setupToken', 'Setup session expired. Please start again.');
		}

		if (payload.userId !== ctx.userId) {
			return ctx.throwValidationError('setupToken', 'Setup session is invalid. Please start again.');
		}

		const isValid = verifyAndConsumeTotpToken(ctx.userId, payload.secret, input.code);

		if (!isValid) {
			return ctx.throwValidationError(
				'code',
				'Invalid code. Make sure your authenticator app is synced and try again.',
			);
		}

		const encryptedSecret = await encryptTotpSecret(payload.secret);
		const newTokenVersion = await rotateUserTotp(ctx.userId, encryptedSecret, JSON.stringify(payload.hashedCodes));

		// Sessions opened before 2FA existed never passed a second factor.
		const reason = 'Two-factor authentication was enabled on your account. Please sign in again.';
		const legacyOwnWs = input.renewSession ? undefined : ctx.getOwnWs();
		if (input.renewSession) {
			revokeOtherUserSessions(ctx, newTokenVersion, reason);
		} else {
			// Legacy clients cannot store renewed tokens. Let the success response
			// flush before closing their connection for an explicit sign-in.
			revokeUserSessions(ctx.userId, { code: DisconnectCode.KICKED, reason, exceptWs: legacyOwnWs });
			if (legacyOwnWs) blockVoiceRestoreAfterKick(ctx.userId, getVoiceKickGuardIdentity(legacyOwnWs));
		}

		enqueueActivityLog({
			type: ActivityLogType.USER_ENABLED_2FA,
			userId: ctx.userId,
		});

		const authTokens = await issueAuthTokens(ctx.userId, newTokenVersion);
		if (legacyOwnWs) setTimeout(() => legacyOwnWs.close(DisconnectCode.KICKED, reason), 0).unref();
		return { success: true, ...authTokens };
	});

const totpDisableRoute = protectedProcedure
	.input(
		z.object({
			password: z.string().min(1),
			code: z.string().length(6),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		const user = await db.select({ password: users.password }).from(users).where(eq(users.id, ctx.userId)).get();

		invariant(user, { code: 'NOT_FOUND', message: 'User not found' });

		const passwordValid = await verifyPassword(input.password, user.password);

		if (!passwordValid) {
			return ctx.throwValidationError('password', 'Password is incorrect');
		}

		const totpData = await getUserTotpData(ctx.userId);

		if (!totpData?.totpSecret) {
			return ctx.throwValidationError('code', 'Two-factor authentication is not enabled');
		}

		const decryptedSecret = await decryptTotpSecret(totpData.totpSecret);
		const isValid = verifyAndConsumeTotpToken(ctx.userId, decryptedSecret, input.code);

		if (!isValid) {
			return ctx.throwValidationError('code', 'Invalid authentication code');
		}

		const newTokenVersion = await rotateUserTotp(ctx.userId, null, null);

		revokeOtherUserSessions(
			ctx,
			newTokenVersion,
			'Two-factor authentication was disabled on your account. Please sign in again.',
		);

		enqueueActivityLog({
			type: ActivityLogType.USER_DISABLED_2FA,
			userId: ctx.userId,
		});

		return { success: true };
	});

const totpRegenerateRecoveryCodesRoute = protectedProcedure
	.input(
		z.object({
			password: z.string().min(1),
			code: z.string().length(6),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		const user = await db.select({ password: users.password }).from(users).where(eq(users.id, ctx.userId)).get();

		invariant(user, { code: 'NOT_FOUND', message: 'User not found' });

		const passwordValid = await verifyPassword(input.password, user.password);

		if (!passwordValid) {
			return ctx.throwValidationError('password', 'Password is incorrect');
		}

		const totpData = await getUserTotpData(ctx.userId);

		if (!totpData?.totpSecret) {
			return ctx.throwValidationError('code', 'Two-factor authentication is not enabled');
		}

		const decryptedSecret = await decryptTotpSecret(totpData.totpSecret);
		const isValid = verifyAndConsumeTotpToken(ctx.userId, decryptedSecret, input.code);

		if (!isValid) {
			return ctx.throwValidationError('code', 'Invalid authentication code');
		}

		const { plainCodes, hashedCodes } = await generateRecoveryCodes();

		await updateUserRecoveryCodes(ctx.userId, hashedCodes);

		enqueueActivityLog({
			type: ActivityLogType.USER_REGENERATED_RECOVERY_CODES,
			userId: ctx.userId,
		});

		return { recoveryCodes: plainCodes };
	});

export {
	totpConfirmSetupRoute,
	totpDisableRoute,
	totpGenerateSetupRoute,
	totpRegenerateRecoveryCodesRoute,
	totpStatusRoute,
};
