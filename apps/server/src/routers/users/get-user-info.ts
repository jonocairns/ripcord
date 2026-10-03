import { ChannelPermission, Permission, type TFile } from '@sharkord/shared';
import z from 'zod';
import { getFilesByUserId } from '../../db/queries/files';
import { getLastLogins } from '../../db/queries/logins';
import { getMessagesByUserId } from '../../db/queries/messages';
import { getUserById } from '../../db/queries/users';
import { generateFileToken } from '../../helpers/files-crypto';
import { invariant } from '../../utils/invariant';
import { type Context, protectedProcedure } from '../../utils/trpc';

// MANAGE_USERS alone does not grant access to private channels. Leave out files
// in private channels the caller cannot view (their names alone can leak private
// content) and sign every other attachment, so every listed file opens.
const getVisibleUserFiles = async (ctx: Context, userId: number): Promise<TFile[]> => {
	const userFiles = await getFilesByUserId(userId);
	const canViewByChannelId = new Map<number, Promise<boolean>>();

	const canViewChannel = (channelId: number) => {
		let canView = canViewByChannelId.get(channelId);

		if (!canView) {
			canView = ctx.hasChannelPermission(channelId, ChannelPermission.VIEW_CHANNEL);
			canViewByChannelId.set(channelId, canView);
		}

		return canView;
	};

	const visibleFiles: TFile[] = [];

	for (const { file, channel } of userFiles) {
		// Not a message attachment (avatar, banner, emoji): public and unsigned.
		if (!channel) {
			visibleFiles.push(file);
			continue;
		}

		if (channel.private && !(await canViewChannel(channel.id))) continue;

		visibleFiles.push({ ...file, _accessToken: generateFileToken(file.id, channel.fileAccessToken) });
	}

	return visibleFiles;
};

const getUserInfoRoute = protectedProcedure
	.input(
		z.object({
			userId: z.number(),
		}),
	)
	.query(async ({ ctx, input }) => {
		await ctx.needsPermission(Permission.MANAGE_USERS);

		const user = await getUserById(input.userId);

		invariant(user, {
			code: 'NOT_FOUND',
			message: 'User not found',
		});

		const [logins, files, messages] = await Promise.all([
			getLastLogins(user.id, 6),
			getVisibleUserFiles(ctx, user.id),
			getMessagesByUserId(user.id),
		]);

		return { user, logins, files, messages };
	});

export { getUserInfoRoute };
