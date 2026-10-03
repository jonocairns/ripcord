import { ChannelPermission } from '@sharkord/shared';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, messageFiles, messages } from '../../db/schema';
import { generateFileToken } from '../../helpers/files-crypto';
import { protectedProcedure } from '../../utils/trpc';

const MAX_FILE_IDS_PER_REQUEST = 100;

// Re-signs attachment links the client already holds, like Discord's
// attachment refresh endpoint: after a token rotation, a reconnect, or before
// expiry. Unlike Discord's, it signs only attachments in channels the caller
// can view (the VIEW_CHANNEL check `messages.get` makes), so a user who lost
// access gets nothing. Unknown IDs and files that are not message attachments
// (avatars, emojis) are left out.
const refreshAccessTokensRoute = protectedProcedure
	.input(
		z.object({
			fileIds: z.array(z.number()).max(MAX_FILE_IDS_PER_REQUEST),
		}),
	)
	.query(async ({ ctx, input }) => {
		if (input.fileIds.length === 0) {
			return [];
		}

		const attachments = await db
			.select({
				fileId: messageFiles.fileId,
				channelId: channels.id,
				fileAccessToken: channels.fileAccessToken,
			})
			.from(messageFiles)
			.innerJoin(messages, eq(messages.id, messageFiles.messageId))
			.innerJoin(channels, eq(channels.id, messages.channelId))
			.where(inArray(messageFiles.fileId, [...new Set(input.fileIds)]));

		const canViewByChannelId = new Map<number, boolean>();

		for (const channelId of new Set(attachments.map((attachment) => attachment.channelId))) {
			canViewByChannelId.set(channelId, await ctx.hasChannelPermission(channelId, ChannelPermission.VIEW_CHANNEL));
		}

		return attachments
			.filter((attachment) => canViewByChannelId.get(attachment.channelId))
			.map(({ fileId, fileAccessToken }) => ({
				fileId,
				accessToken: generateFileToken(fileId, fileAccessToken),
			}));
	});

export { refreshAccessTokensRoute };
