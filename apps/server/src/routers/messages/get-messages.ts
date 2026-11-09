import {
	ChannelPermission,
	DEFAULT_MESSAGES_LIMIT,
	ServerEvents,
	type TFile,
	type TJoinedMessage,
	type TJoinedMessageReaction,
	type TMessage,
} from '@sharkord/shared';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getChannelsReadStatesForUser } from '../../db/queries/channels';
import { channelReadStates, channels, files, messageFiles, messageReactions, messages } from '../../db/schema';
import { generateFileToken } from '../../helpers/files-crypto';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const MAX_MESSAGES_PAGE_SIZE = 100;

const getMessagesRoute = protectedProcedure
	.input(
		z.object({
			channelId: z.number(),
			cursor: z.number().nullish(),
			limit: z.number().int().min(1).default(DEFAULT_MESSAGES_LIMIT),
		}),
	)
	.meta({ infinite: true })
	.query(async ({ ctx, input }) => {
		await ctx.needsChannelPermission(input.channelId, ChannelPermission.VIEW_CHANNEL);

		const { channelId, cursor } = input;
		const limit = Math.min(input.limit, MAX_MESSAGES_PAGE_SIZE);

		const channel = await db
			.select({
				fileAccessToken: channels.fileAccessToken,
			})
			.from(channels)
			.where(eq(channels.id, channelId))
			.get();

		invariant(channel, {
			code: 'NOT_FOUND',
			message: 'Channel not found',
		});

		const rows: TMessage[] = await db
			.select()
			.from(messages)
			.where(
				cursor
					? and(eq(messages.channelId, channelId), lt(messages.createdAt, cursor))
					: eq(messages.channelId, channelId),
			)
			.orderBy(desc(messages.createdAt), desc(messages.id))
			.limit(limit + 1);

		let nextCursor: number | null = null;

		if (rows.length > limit) {
			const lookAhead = rows.pop();

			if (lookAhead) {
				// Include the look-ahead row on the next page. Clients dedupe timestamp ties by id.
				nextCursor = lookAhead.createdAt + 1;

				// A timestamp group larger than one page cannot fit on a page with a
				// numeric cursor. Advance past it rather than returning the same page
				// forever; that group's oldest rows beyond the page size are skipped.
				// Messages are inserted one per request with Date.now(), so this does
				// not happen in practice.
				if (nextCursor === cursor) {
					nextCursor = lookAhead.createdAt;
				}
			}
		}

		if (rows.length === 0) {
			return { messages: [], nextCursor };
		}

		const messageIds = rows.map((m) => m.id);

		const [fileRows, reactionRows] = await Promise.all([
			db
				.select({
					messageId: messageFiles.messageId,
					file: files,
				})
				.from(messageFiles)
				.innerJoin(files, eq(messageFiles.fileId, files.id))
				.where(inArray(messageFiles.messageId, messageIds)),
			db
				.select({
					messageId: messageReactions.messageId,
					userId: messageReactions.userId,
					emoji: messageReactions.emoji,
					createdAt: messageReactions.createdAt,
					fileId: messageReactions.fileId,
					file: files,
				})
				.from(messageReactions)
				.leftJoin(files, eq(messageReactions.fileId, files.id))
				.where(inArray(messageReactions.messageId, messageIds)),
		]);

		const filesByMessage = fileRows.reduce<Record<number, TFile[]>>((acc, row) => {
			if (!acc[row.messageId]) {
				acc[row.messageId] = [];
			}

			// Every attachment is signed, as on Discord. Signing is keyed by the
			// channel's file access token, so rotating it invalidates every link in
			// the channel; a private toggle leaves the tokens clients hold valid.
			const rowCopy: TFile = {
				...row.file,
				_accessToken: generateFileToken(row.file.id, channel.fileAccessToken),
			};

			acc[row.messageId]!.push(rowCopy);

			return acc;
		}, {});

		const reactionsByMessage = reactionRows.reduce<Record<number, TJoinedMessageReaction[]>>((acc, r) => {
			const reaction: TJoinedMessageReaction = {
				messageId: r.messageId,
				userId: r.userId,
				emoji: r.emoji,
				createdAt: r.createdAt,
				fileId: r.fileId,
				file: r.file,
			};

			if (!acc[r.messageId]) {
				acc[r.messageId] = [];
			}

			acc[r.messageId]!.push(reaction);

			return acc;
		}, {});

		// Combine messages with files and reactions
		const messagesWithFiles: TJoinedMessage[] = rows.map((msg) => ({
			...msg,
			files: filesByMessage[msg.id] ?? [],
			reactions: reactionsByMessage[msg.id] ?? [],
		}));

		// always update read state to the absolute latest message in the channel
		// (not just the newest in this batch, in case user is scrolling back through history)
		// this is not ideal, but it's good enough for now
		const [, , latestMessage] = await Promise.all([
			Promise.resolve(fileRows),
			Promise.resolve(reactionRows),
			db
				.select()
				.from(messages)
				.where(eq(messages.channelId, channelId))
				.orderBy(desc(messages.createdAt))
				.limit(1)
				.get(),
		]);

		if (latestMessage) {
			await db
				.insert(channelReadStates)
				.values({
					channelId,
					userId: ctx.userId,
					lastReadMessageId: latestMessage.id,
					lastReadAt: Date.now(),
				})
				.onConflictDoUpdate({
					target: [channelReadStates.channelId, channelReadStates.userId],
					set: {
						lastReadMessageId: latestMessage.id,
						lastReadAt: Date.now(),
					},
				});

			const updatedReadStates = await getChannelsReadStatesForUser(ctx.userId, channelId);

			pubsub.publishFor(ctx.userId, ServerEvents.CHANNEL_READ_STATES_UPDATE, {
				channelId,
				count: updatedReadStates[channelId] ?? 0,
			});
		}

		return { messages: messagesWithFiles, nextCursor };
	});

export { getMessagesRoute };
