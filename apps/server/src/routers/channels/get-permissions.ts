import { ChannelPermission, Permission } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channelRolePermissions, channels, channelUserPermissions } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getPermissionsRoute = protectedProcedure
	.input(
		z.object({
			channelId: z.number(),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.MANAGE_CHANNEL_PERMISSIONS);

		const channel = await db
			.select({ id: channels.id, private: channels.private })
			.from(channels)
			.where(eq(channels.id, input.channelId))
			.get();
		invariant(channel, { code: 'NOT_FOUND', message: 'Channel not found' });
		if (channel.private) {
			await ctx.needsChannelPermission(channel.id, ChannelPermission.VIEW_CHANNEL);
		}

		const [rolePermissions, userPermissions] = await Promise.all([
			db.select().from(channelRolePermissions).where(eq(channelRolePermissions.channelId, input.channelId)),
			db.select().from(channelUserPermissions).where(eq(channelUserPermissions.channelId, input.channelId)),
		]);

		return {
			rolePermissions,
			userPermissions,
		};
	});

export { getPermissionsRoute };
