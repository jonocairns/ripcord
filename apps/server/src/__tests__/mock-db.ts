import { Database } from 'bun:sqlite';
import { mock } from 'bun:test';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import fs from 'fs';
import path from 'path';
import { DRIZZLE_PATH as EMBEDDED_DRIZZLE_PATH } from '../helpers/paths';
import { seedDatabase } from './seed';

/**
 * This file is preloaded FIRST (via bunfig.toml) to mock the db module
 * before any other code imports it.
 *
 * Architecture:
 * 1. mock-db.ts (this file) - Creates initial db for module imports
 * 2. setup.ts - beforeEach creates fresh db for each test
 *
 * The initial db here ensures that helper functions (like getMockedToken)
 * that are imported at module-level can access a valid database.
 * Then setup.ts replaces it with a fresh db for each test.
 *
 * CRITICAL: We use a Proxy to ensure all database access goes through
 * the getter, so that setTestDb() properly updates the active database.
 */

let tdb: BunSQLiteDatabase;
const isServerTestFile = Bun.main.includes('/apps/server/');

const sourceMigrationsPath = path.resolve(import.meta.dir, '../db/migrations');

const DRIZZLE_PATH = fs.existsSync(
  path.join(EMBEDDED_DRIZZLE_PATH, 'meta', '_journal.json')
)
  ? EMBEDDED_DRIZZLE_PATH
  : sourceMigrationsPath;

const initDb = async () => {
  const sqlite = new Database(':memory:', { create: true, strict: true });

  sqlite.run('PRAGMA foreign_keys = ON;');

  tdb = drizzle({ client: sqlite });

  await migrate(tdb, { migrationsFolder: DRIZZLE_PATH });
  await seedDatabase(tdb);

  return tdb;
};

if (isServerTestFile) {
  await initDb();

  // create a Proxy that forwards all operations to the current test context db
  const dbProxy = new Proxy({} as BunSQLiteDatabase, {
    get(_target, prop) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (tdb as any)[prop];
    },
    set(_target, prop, value) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tdb as any)[prop] = value;
      return true;
    }
  });

  mock.module('../db/index', () => ({
    db: dbProxy,
    loadDb: async () => {} // No-op in tests
  }));
}

const setTestDb = (newDb: BunSQLiteDatabase) => {
  tdb = newDb;
};

const getTestDb = () => {
  if (!tdb) {
    throw new Error('Test database is not initialized');
  }

  return tdb;
};

export { DRIZZLE_PATH, getTestDb, setTestDb };
