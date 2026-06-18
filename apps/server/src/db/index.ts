import { Database } from 'bun:sqlite';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { DB_PATH, DRIZZLE_PATH } from '../helpers/paths';
import { logger } from '../logger';
import { seedDatabase } from './seed';

let db: BunSQLiteDatabase;
let sqlite: Database | undefined;

const loadDb = async () => {
	sqlite = new Database(DB_PATH, { create: true, strict: true });

	sqlite.run('PRAGMA journal_mode = WAL;');
	sqlite.run('PRAGMA foreign_keys = ON;');
	// Without a busy timeout, any write that hits a momentarily-locked database
	// (WAL still serialises writers) fails outright with SQLITE_BUSY instead of
	// waiting — surfacing as sporadic request failures under concurrency. Wait up
	// to 5s for the lock to clear before giving up.
	sqlite.run('PRAGMA busy_timeout = 5000;');
	// WAL makes synchronous=NORMAL safe (no corruption on app crash; only a
	// last-transaction loss on OS/power loss) while removing an fsync per commit.
	sqlite.run('PRAGMA synchronous = NORMAL;');

	db = drizzle({ client: sqlite });

	await migrate(db, { migrationsFolder: DRIZZLE_PATH });
	await seedDatabase();
};

// Lightweight readiness probe — confirms the database handle is open and
// answering. Uniform contract: any failure (no handle, or a failing query)
// returns false, so callers just read the boolean.
const pingDb = (): boolean => {
	if (!sqlite) {
		return false;
	}

	try {
		sqlite.query('SELECT 1;').get();
		return true;
	} catch (error) {
		logger.error('Database readiness probe failed', error);
		return false;
	}
};

// Clean shutdown: checkpoints the WAL and releases the file handle so the next
// start doesn't recover from a large WAL.
const closeDb = (): void => {
	if (!sqlite) {
		return;
	}

	sqlite.close();
	sqlite = undefined;
};

export { closeDb, db, loadDb, pingDb };
