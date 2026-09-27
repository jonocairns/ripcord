import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { DRIZZLE_PATH, setTestDb } from '../../__tests__/mock-db';
import { seedDatabase } from '../../__tests__/seed';
import { UPLOADS_PATH } from '../../helpers/paths';
import { fileManager } from '../file-manager';

let stagingDatabase: Database | undefined;
let leftover: Awaited<ReturnType<typeof fileManager.addTemporaryFile>> | undefined;

beforeAll(async () => {
	// Stage an abandoned upload before the global beforeEach runs. A dedicated
	// database keeps this fixture independent of previously executed test files.
	stagingDatabase = new Database(':memory:', { create: true, strict: true });
	const stagingDb = drizzle({ client: stagingDatabase });
	await migrate(stagingDb, { migrationsFolder: DRIZZLE_PATH });
	await seedDatabase(stagingDb);
	setTestDb(stagingDb);
	const filePath = path.join(UPLOADS_PATH, `isolation-${crypto.randomUUID()}.txt`);
	await fs.writeFile(filePath, 'abandoned upload');
	leftover = await fileManager.addTemporaryFile({ filePath, size: 16, originalName: 'abandoned.txt', userId: 1 });
	expect(fileManager.temporaryFileExists(leftover.id)).toBe(true);
});

afterAll(async () => {
	if (leftover && fileManager.temporaryFileExists(leftover.id)) await fileManager.removeTemporaryFile(leftover.id);
	stagingDatabase?.close();
});

test('the global test hook removes a staged upload from memory and disk', async () => {
	if (!leftover) throw new Error('Missing staged upload');
	expect(fileManager.temporaryFileExists(leftover.id)).toBe(false);
	expect(await fs.exists(leftover.path)).toBe(false);
});
