import { Permission } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { toPublicChannel } from '../../helpers/to-public-channel';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getChannelRoute = protectedProcedure
	.input(
		z.object({
			channelId: z.number().min(1),
		}),
	)
	.query(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.MANAGE_CHANNELS);

		const channel = await db.select().from(channels).where(eq(channels.id, input.channelId)).get();

		invariant(channel, {
			code: 'NOT_FOUND',
			message: 'Channel not found',
		});

		return toPublicChannel(channel);
	});

export { getChannelRoute };
