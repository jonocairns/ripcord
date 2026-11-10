import { ActivityLogType, ChannelPermission, Permission } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { channels } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const deleteChannelRoute = protectedProcedure
	.input(
		z.object({
			channelId: z.number(),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.MANAGE_CHANNELS);

		const channel = await db.select().from(channels).where(eq(channels.id, input.channelId)).get();

		invariant(channel, {
			code: 'NOT_FOUND',
			message: 'Channel not found',
		});

		if (channel.private) {
			await ctx.needsChannelPermission(channel.id, ChannelPermission.VIEW_CHANNEL);
		}

		const removedChannel = await db.delete(channels).where(eq(channels.id, channel.id)).returning().get();

		invariant(removedChannel, {
			code: 'NOT_FOUND',
			message: 'Channel not found',
		});

		const runtime = VoiceRuntime.findById(removedChannel.id);

		if (runtime) {
			runtime.destroy();
		}

		publishChannel(removedChannel.id, 'delete');
		enqueueActivityLog({
			type: ActivityLogType.DELETED_CHANNEL,
			userId: ctx.user.id,
			details: {
				channelId: removedChannel.id,
				channelName: removedChannel.name,
			},
		});
	});

export { deleteChannelRoute };
