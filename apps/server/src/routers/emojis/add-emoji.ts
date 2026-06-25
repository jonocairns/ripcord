import { ActivityLogType, emojiNameSchema, Permission } from '@sharkord/shared';
import { z } from 'zod';
import { db } from '../../db';
import { publishEmoji } from '../../db/publishers';
import { emojiExists } from '../../db/queries/emojis';
import { emojis } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { fileManager } from '../../utils/file-manager';
import { protectedProcedure } from '../../utils/trpc';

const addEmojiRoute = protectedProcedure
	.input(
		z.array(
			z.object({
				fileId: z.string(),
				name: emojiNameSchema,
			}),
		),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.MANAGE_EMOJIS);

		// Pre-flight conflict check before any file saves/inserts so a clash
		// part-way through the batch doesn't leave emojis partially created.
		const seen = new Set<string>();

		for (const data of input) {
			if (seen.has(data.name) || (await emojiExists(data.name))) {
				ctx.throwValidationError('name', `An emoji named :${data.name}: already exists.`);
			}

			seen.add(data.name);
		}

		for (const data of input) {
			const newFile = await fileManager.saveFile(data.fileId, ctx.userId);

			const emoji = db
				.insert(emojis)
				.values({
					name: data.name,
					fileId: newFile.id,
					userId: ctx.userId,
					createdAt: Date.now(),
				})
				.returning()
				.get();

			publishEmoji(emoji.id, 'create');
			enqueueActivityLog({
				type: ActivityLogType.CREATED_EMOJI,
				userId: ctx.user.id,
				details: {
					name: emoji.name,
				},
			});
		}
	});

export { addEmojiRoute };
