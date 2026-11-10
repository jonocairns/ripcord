import { ActivityLogType, ChannelPermission, Permission } from '@sharkord/shared';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { loadChannelGrants, loadUserGrants } from '../../db/queries/permissions';
import { channels } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { hasChannelAccess, hasGlobalPermission } from '../../utils/permission-policy';
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

		const categoryChannelIds = db.transaction((tx) => {
			// The asynchronous authorization lookup can overlap a role change. Recheck
			// the current global grant in the same snapshot as membership and visibility.
			// Drizzle's bun-sqlite transaction shares db's session and SQLite connection
			// (verified for drizzle-orm 0.45.4), so these synchronous loaders read inside
			// this transaction too. Recheck this if drizzle or the driver changes.
			const userGrants = loadUserGrants(ctx.user.id);
			invariant(hasGlobalPermission(userGrants, Permission.MANAGE_CHANNELS), {
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
				hasChannelAccess(userGrants, loadChannelGrants(ctx.user.id, channel.id), ChannelPermission.VIEW_CHANNEL),
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

		await Promise.all(categoryChannelIds.map((channelId) => publishChannel(channelId, 'update')));

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
