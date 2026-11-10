import { ActivityLogType, OWNER_ROLE_ID, Permission } from '@sharkord/shared';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { getChannelViewerIdsSync } from '../../db/queries/channels';
import { channels, rolePermissions, userRoles, users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const reorderChannelsRoute = protectedProcedure
	.input(
		z.object({
			categoryId: z.number(),
			channelIds: z.array(z.number()),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.MANAGE_CHANNELS);

		const categoryIds = db.transaction((tx) => {
			// The asynchronous authorization lookup can overlap a role change. Recheck
			// the current global grant in the same snapshot as membership and visibility.
			const user = tx.select({ banned: users.banned }).from(users).where(eq(users.id, ctx.user.id)).get();
			const roleIds = tx
				.select({ id: userRoles.roleId })
				.from(userRoles)
				.where(eq(userRoles.userId, ctx.user.id))
				.all();
			const globalGrant = tx
				.select({ id: userRoles.roleId })
				.from(userRoles)
				.innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
				.where(and(eq(userRoles.userId, ctx.user.id), eq(rolePermissions.permission, Permission.MANAGE_CHANNELS)))
				.get();
			invariant(user && !user.banned && (roleIds.some((role) => role.id === OWNER_ROLE_ID) || globalGrant), {
				code: 'FORBIDDEN',
				message: 'Insufficient permissions',
			});

			const currentChannels = tx
				.select()
				.from(channels)
				.where(eq(channels.categoryId, input.categoryId))
				.orderBy(asc(channels.position), asc(channels.id))
				.all();
			// No await may separate this visibility decision from the writes. Build
			// a bijection over current members, including members added during lookup.
			const viewableChannels = currentChannels.filter((channel) =>
				getChannelViewerIdsSync(channel.id)?.includes(ctx.user.id),
			);
			const viewableIds = new Set(viewableChannels.map((channel) => channel.id));
			const orderedIds = new Set(input.channelIds.filter((id) => viewableIds.has(id)));
			for (const channel of viewableChannels) orderedIds.add(channel.id);
			const nextViewableIds = orderedIds.values();
			for (const [index, channel] of currentChannels.entries()) {
				// Hidden channels keep ordinal slots; normalization can repair numeric collisions.
				const channelId = viewableIds.has(channel.id) ? nextViewableIds.next().value : channel.id;
				if (channelId === undefined) throw new Error('Missing channel in reorder');
				tx.update(channels)
					.set({ position: index + 1, updatedAt: Date.now() })
					.where(eq(channels.id, channelId))
					.run();
			}
			return currentChannels.map((channel) => channel.id);
		});

		await Promise.all(categoryIds.map((channelId) => publishChannel(channelId, 'update')));

		if (input.channelIds.length > 0) {
			enqueueActivityLog({
				type: ActivityLogType.UPDATED_CHANNEL,
				userId: ctx.user.id,
				details: {
					channelId: input.channelIds[0]!,
					values: {
						position: input.channelIds.length,
					},
				},
			});
		}
	});

export { reorderChannelsRoute };
