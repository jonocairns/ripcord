import { ActivityLogType, Permission } from '@sharkord/shared';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { getChannelsForUser } from '../../db/queries/channels';
import { channels } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
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

		const categoryChannels = await db
			.select()
			.from(channels)
			.where(eq(channels.categoryId, input.categoryId))
			.orderBy(asc(channels.position), asc(channels.id));
		const viewableChannels = await getChannelsForUser(ctx.user.id, categoryChannels);
		const viewableIds = new Set(viewableChannels.map((channel) => channel.id));
		const orderedIds = new Set(input.channelIds.filter((id) => viewableIds.has(id)));
		for (const channel of viewableChannels) orderedIds.add(channel.id);

		const categoryIds = db.transaction((tx) => {
			const currentChannels = tx
				.select()
				.from(channels)
				.where(eq(channels.categoryId, input.categoryId))
				.orderBy(asc(channels.position), asc(channels.id))
				.all();
			const currentIds = new Set(currentChannels.map((channel) => channel.id));
			const nextViewableIds = [...orderedIds].filter((id) => currentIds.has(id)).values();
			for (const [index, channel] of currentChannels.entries()) {
				// Hidden channels keep their slots while visible channels fill the rest.
				const channelId = viewableIds.has(channel.id) ? nextViewableIds.next().value : channel.id;
				if (channelId === undefined) throw new Error('Missing channel in reorder');
				tx.update(channels)
					.set({ position: index + 1, updatedAt: Date.now() })
					.where(eq(channels.id, channelId))
					.run();
			}
			return currentChannels.map((channel) => channel.id);
		});

		categoryIds.forEach((channelId) => {
			publishChannel(channelId, 'update');
		});

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
