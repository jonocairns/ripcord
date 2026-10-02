import { ChannelPermission, isEmptyMessage, Permission } from '@sharkord/shared';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { publishMessage } from '../../db/publishers';
import { messageFiles, messages } from '../../db/schema';
import { sanitizeMessageHtml } from '../../helpers/sanitize-html';
import { eventBus } from '../../plugins/event-bus';
import { enqueueProcessMetadata } from '../../queues/message-metadata';
import { fileManager } from '../../utils/file-manager';
import { invariant } from '../../utils/invariant';
import { protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';

const sendMessageRoute = rateLimitedProcedure(protectedProcedure, {
	maxRequests: config.rateLimiters.sendAndEditMessage.maxRequests,
	windowMs: config.rateLimiters.sendAndEditMessage.windowMs,
	logLabel: 'sendMessage',
})
	.input(
		z
			.object({
				content: z.string(),
				channelId: z.number(),
				files: z.array(z.string()).optional(),
			})
			.required(),
	)
	.mutation(async ({ input, ctx }) => {
		await Promise.all([
			ctx.needsPermission(Permission.SEND_MESSAGES),
			ctx.needsChannelPermission(input.channelId, ChannelPermission.SEND_MESSAGES),
		]);

		invariant(!isEmptyMessage(input.content) || input.files.length !== 0, {
			code: 'BAD_REQUEST',
			message: 'Message cannot be empty.',
		});

		const targetContent = sanitizeMessageHtml(input.content);

		invariant(!isEmptyMessage(targetContent) || input.files.length !== 0, {
			code: 'BAD_REQUEST',
			message: 'Your message only contained unsupported or removed content, so there was nothing to send.',
		});

		const message = await db
			.insert(messages)
			.values({
				channelId: input.channelId,
				userId: ctx.userId,
				content: targetContent,
				createdAt: Date.now(),
			})
			.returning()
			.get();

		if (input.files.length > 0) {
			for (const tempFileId of input.files) {
				const newFile = await fileManager.saveFile(tempFileId, ctx.userId);

				await db.insert(messageFiles).values({
					messageId: message.id,
					fileId: newFile.id,
					createdAt: Date.now(),
				});
			}
		}

		publishMessage(message.id, input.channelId, 'create');
		enqueueProcessMetadata(targetContent, message.id);

		eventBus.emit('message:created', {
			messageId: message.id,
			channelId: input.channelId,
			userId: ctx.userId,
			content: targetContent,
		});

		return message.id;
	});

export { sendMessageRoute };
