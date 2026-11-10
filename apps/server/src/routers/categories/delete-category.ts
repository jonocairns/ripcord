import { ActivityLogType, ChannelPermission, Permission } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishCategory, publishChannel } from '../../db/publishers';
import { categories, channels } from '../../db/schema';
import { logger } from '../../logger';
import { enqueueActivityLog } from '../../queues/activity-log';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const deleteCategoryRoute = protectedProcedure
	.input(
		z.object({
			categoryId: z.number(),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.MANAGE_CATEGORIES);

		const removedCategory = await db.select().from(categories).where(eq(categories.id, input.categoryId)).get();

		invariant(removedCategory, { code: 'NOT_FOUND', message: 'Category not found' });

		const categoryChannels = await db.select().from(channels).where(eq(channels.categoryId, removedCategory.id));

		if (categoryChannels.length > 0) {
			await ctx.needsPermission(Permission.MANAGE_CHANNELS);

			for (const channel of categoryChannels) {
				if (channel.private) {
					await ctx.needsChannelPermission(channel.id, ChannelPermission.VIEW_CHANNEL);
				}
			}
		}

		const checkedChannelIds = new Set(categoryChannels.map((channel) => channel.id));

		db.transaction((tx) => {
			const deletedChannels = tx
				.delete(channels)
				.where(eq(channels.categoryId, removedCategory.id))
				.returning({ id: channels.id })
				.all();

			// A channel moved into or out of the category after the permission check
			// would be deleted unchecked or announced while it still exists; abort.
			invariant(
				deletedChannels.length === checkedChannelIds.size &&
					deletedChannels.every((channel) => checkedChannelIds.has(channel.id)),
				{ code: 'CONFLICT', message: 'Category channels changed, try again' },
			);

			tx.delete(categories).where(eq(categories.id, removedCategory.id)).run();
		});

		for (const channel of categoryChannels) {
			// The rows are already gone: keep announcing the remaining deletions even
			// if one runtime fails to shut down cleanly.
			try {
				await VoiceRuntime.findById(channel.id)?.destroy();
			} catch (error) {
				logger.error('Failed to destroy voice runtime for deleted channel %d', channel.id, error);
			}

			await publishChannel(channel.id, 'delete');
		}

		publishCategory(removedCategory.id, 'delete');
		enqueueActivityLog({
			type: ActivityLogType.DELETED_CATEGORY,
			userId: ctx.user.id,
			details: {
				categoryId: removedCategory.id,
				categoryName: removedCategory.name,
			},
		});
	});

export { deleteCategoryRoute };
