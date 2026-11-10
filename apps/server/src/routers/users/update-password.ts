import { ActivityLogType } from '@sharkord/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { refreshTokens, users } from '../../db/schema';
import { hashPassword, verifyPassword } from '../../helpers/password';
import { issueAuthTokens } from '../../http/auth-tokens';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { revokeOtherUserSessions } from '../../utils/user-sessions';
import { passwordCheckProcedure } from './password-check-procedure';

const updatePasswordRoute = passwordCheckProcedure
	.input(
		z.object({
			currentPassword: z.string().min(4).max(128),
			newPassword: z.string().min(8).max(128),
			confirmNewPassword: z.string().min(8).max(128),
			renewSession: z.boolean().optional(),
		}),
	)
	.mutation(async ({ ctx, input }) => {
		const now = Date.now();
		const user = db
			.select({ password: users.password, tokenVersion: users.tokenVersion })
			.from(users)
			.where(eq(users.id, ctx.userId))
			.get();

		invariant(user, {
			code: 'NOT_FOUND',
			message: 'User not found',
		});

		const isCurrentPasswordValid = await verifyPassword(input.currentPassword, user.password);

		if (!isCurrentPasswordValid) {
			ctx.throwValidationError('currentPassword', 'Current password is incorrect');
		}

		if (input.newPassword !== input.confirmNewPassword) {
			ctx.throwValidationError('confirmNewPassword', 'New password and confirmation do not match');
		}

		const hashedNewPassword = await hashPassword(input.newPassword);

		const newTokenVersion = db.transaction((tx) => {
			const currentUser = tx
				.select({ password: users.password, tokenVersion: users.tokenVersion })
				.from(users)
				.where(eq(users.id, ctx.userId))
				.get();

			invariant(currentUser, {
				code: 'NOT_FOUND',
				message: 'User not found',
			});

			invariant(currentUser.password === user.password, {
				code: 'CONFLICT',
				message: 'Your password was changed in another session. Please try again.',
			});

			invariant(currentUser.tokenVersion === user.tokenVersion, {
				code: 'CONFLICT',
				message: 'Your session changed while updating the password. Please sign in and try again.',
			});

			const userUpdateData = {
				password: hashedNewPassword,
				mustChangePassword: false,
				tokenVersion: sql`${users.tokenVersion} + 1`,
			};

			const updatedUser = tx
				.update(users)
				.set(userUpdateData)
				.where(eq(users.id, ctx.userId))
				.returning({ tokenVersion: users.tokenVersion })
				.get();

			invariant(updatedUser, {
				code: 'NOT_FOUND',
				message: 'User not found',
			});

			tx.update(refreshTokens)
				.set({
					revokedAt: now,
					updatedAt: now,
				})
				.where(and(eq(refreshTokens.userId, ctx.userId), isNull(refreshTokens.revokedAt)))
				.run();

			return updatedUser.tokenVersion;
		});

		ctx.user.mustChangePassword = false;
		revokeOtherUserSessions(ctx, newTokenVersion, 'Your password was changed. Please sign in again.');

		enqueueActivityLog({
			type: ActivityLogType.USER_UPDATED_PASSWORD,
			userId: ctx.user.id,
		});
		if (input.renewSession) return issueAuthTokens(ctx.userId, newTokenVersion);
	});

export { updatePasswordRoute };
