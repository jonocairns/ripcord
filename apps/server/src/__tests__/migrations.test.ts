import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { getChannelsReadStatesForUser } from '../db/queries/channels';
import { channelReadStates, messages } from '../db/schema';
import { SRC_MIGRATIONS_PATH } from '../helpers/paths';
import { tdb } from './setup';

const CHANNEL_ID = 1;
const AUTHOR_ID = 1;
const READER_ID = 2;

// the test db is already fully migrated, so data migrations are re-applied to rows
// inserted afterwards, split into statements the same way the drizzle migrator does
const applyMigration = async (tag: string) => {
	const migration = await fs.readFile(path.join(SRC_MIGRATIONS_PATH, `${tag}.sql`), 'utf8');

	for (const statement of migration.split('--> statement-breakpoint')) {
		tdb.run(sql.raw(statement));
	}
};

const insertMessage = async (content: string) => {
	const message = await tdb
		.insert(messages)
		.values({ channelId: CHANNEL_ID, userId: AUTHOR_ID, content, createdAt: Date.now() })
		.returning()
		.get();

	return message.id;
};

describe('migrations', () => {
	test('0014 deletes command messages without marking read channels unread', async () => {
		const commandContent = '<command data-plugin-id="plugin-b" data-command="test-command"></command>';

		const readId = await insertMessage('<p>read</p>');
		await insertMessage(commandContent);
		const lastReadCommandId = await insertMessage(commandContent);
		const unreadId = await insertMessage('<p>&lt;command look-alike</p>');

		await tdb.insert(channelReadStates).values({
			userId: READER_ID,
			channelId: CHANNEL_ID,
			lastReadMessageId: lastReadCommandId,
			lastReadAt: Date.now(),
		});

		expect(await getChannelsReadStatesForUser(READER_ID, CHANNEL_ID)).toEqual({ [CHANNEL_ID]: 1 });

		await applyMigration('0014_delete_command_messages');

		const remaining = await tdb.select({ id: messages.id, content: messages.content }).from(messages);
		const readState = await tdb
			.select()
			.from(channelReadStates)
			.where(and(eq(channelReadStates.userId, READER_ID), eq(channelReadStates.channelId, CHANNEL_ID)))
			.get();

		expect(remaining.some((message) => message.content?.startsWith('<command'))).toBe(false);
		expect(remaining.map((message) => message.id)).toContain(unreadId);
		expect(readState?.lastReadMessageId).toBe(readId);
		expect(await getChannelsReadStatesForUser(READER_ID, CHANNEL_ID)).toEqual({ [CHANNEL_ID]: 1 });
	});
});
