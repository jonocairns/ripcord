import {
  ChannelPermission,
  DEFAULT_MESSAGES_LIMIT,
  type TFile,
  type TJoinedMessage,
  type TJoinedMessageReaction,
  type TMessage
} from '@sharkord/shared';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  files,
  messageFiles,
  messageReactions,
  messages
} from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const getMessagesRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      cursor: z.number().nullish(),
      limit: z.number().default(DEFAULT_MESSAGES_LIMIT)
    })
  )
  .meta({ infinite: true })
  .query(async ({ ctx, input }) => {
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    const { channelId, cursor, limit } = input;

    const rows: TMessage[] = await db
      .select()
      .from(messages)
      .where(
        cursor
          ? and(
              eq(messages.channelId, channelId),
              lt(messages.createdAt, cursor)
            )
          : eq(messages.channelId, channelId)
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit + 1);

    let nextCursor: number | null = null;
    if (rows.length > limit) {
      const next = rows.pop();
      nextCursor = next ? next.createdAt : null;
    }

    const messageIds = rows.map((m) => m.id);
    if (messageIds.length === 0) {
      return { messages: [], nextCursor };
    }

    const fileRows = await db
      .select({
        messageId: messageFiles.messageId,
        file: files
      })
      .from(messageFiles)
      .innerJoin(files, eq(messageFiles.fileId, files.id))
      .where(inArray(messageFiles.messageId, messageIds));

    const filesByMessage: Record<number, TFile[]> = {};

    for (const row of fileRows) {
      if (!filesByMessage[row.messageId]) {
        filesByMessage[row.messageId] = [];
      }

      filesByMessage[row.messageId]!.push(row.file);
    }

    const reactionRows = await db
      .select({
        messageId: messageReactions.messageId,
        userId: messageReactions.userId,
        emoji: messageReactions.emoji,
        createdAt: messageReactions.createdAt,
        fileId: messageReactions.fileId,
        file: files
      })
      .from(messageReactions)
      .leftJoin(files, eq(messageReactions.fileId, files.id))
      .where(inArray(messageReactions.messageId, messageIds));

    const reactionsByMessage: Record<number, TJoinedMessageReaction[]> = {};
    for (const r of reactionRows) {
      const reaction: TJoinedMessageReaction = {
        messageId: r.messageId,
        userId: r.userId,
        emoji: r.emoji,
        createdAt: r.createdAt,
        fileId: r.fileId,
        file: r.file
      };

      if (!reactionsByMessage[r.messageId]) {
        reactionsByMessage[r.messageId] = [];
      }

      reactionsByMessage[r.messageId]!.push(reaction);
    }

    const messagesWithFiles: TJoinedMessage[] = rows.map((msg) => ({
      ...msg,
      files: filesByMessage[msg.id] ?? [],
      reactions: reactionsByMessage[msg.id] ?? []
    }));

    return { messages: messagesWithFiles, nextCursor };
  });

export { getMessagesRoute };
