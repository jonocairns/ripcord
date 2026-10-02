import { ChannelPermission } from '@sharkord/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, messageFiles, messages } from '../../db/schema';
import { generateFileToken } from '../../helpers/files-crypto';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const MAX_FILE_IDS_PER_REQUEST = 100;

// Lets a client refresh the file links it holds for one channel, after a token
// rotation, the channel turning private, or a reconnect. Signs with the same
// VIEW_CHANNEL check as `messages.get`, so a user who lost access gets nothing.
const getAccessTokensRoute = protectedProcedure
	.input(
		z.object({
			channelId: z.number(),
			fileIds: z.array(z.number()).max(MAX_FILE_IDS_PER_REQUEST),
		}),
	)
	.query(async ({ ctx, input }) => {
		await ctx.needsChannelPermission(input.channelId, ChannelPermission.VIEW_CHANNEL);

		const channel = await db
			.select({
				private: channels.private,
				fileAccessToken: channels.fileAccessToken,
			})
			.from(channels)
			.where(eq(channels.id, input.channelId))
			.get();

		invariant(channel, {
			code: 'NOT_FOUND',
			message: 'Channel not found',
		});

		// Public channel files need no token. Leaving them out tells the client to
		// clear any token it still holds for them.
		if (!channel.private || input.fileIds.length === 0) {
			return [];
		}

		// Only files attached to messages in this channel; other IDs are left out.
		const channelFiles = await db
			.select({ fileId: messageFiles.fileId })
			.from(messageFiles)
			.innerJoin(messages, eq(messages.id, messageFiles.messageId))
			.where(and(eq(messages.channelId, input.channelId), inArray(messageFiles.fileId, input.fileIds)));

		return channelFiles.map(({ fileId }) => ({
			fileId,
			accessToken: generateFileToken(fileId, channel.fileAccessToken),
		}));
	});

export { getAccessTokensRoute };
