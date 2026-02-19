import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, mock } from 'bun:test';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import fs from 'fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { DATA_PATH } from '../helpers/paths';
import { createHttpServer } from '../http';
import { loadMediasoup } from '../utils/mediasoup';
import { clearRateLimitersForTests } from '../utils/rate-limiters/rate-limiter';
import { DRIZZLE_PATH, setTestDb } from './mock-db';
import { seedDatabase } from './seed';

/**
 * Global test setup - creates a fresh isolated database before each test.
 * This ensures tests don't interfere with each other.
 *
 * The database is:
 * 1. Created in-memory (fast, isolated)
 * 2. Migrated (applies schema)
 * 3. Seeded (with test data)
 * 4. Set as the mocked db (via setTestDb)
 * 5. Cleaned up after the test
 */

const DISABLE_CONSOLE = true;
const CLEANUP_AFTER_FINISH = true;

if (DISABLE_CONSOLE) {
  const noop = () => {};

  global.console.log = noop;
  global.console.info = noop;
  global.console.warn = noop;
  global.console.debug = noop;

  mock.module('../logger', () => ({
    logger: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      trace: noop,
      fatal: noop
    }
  }));
}

let tdb: BunSQLiteDatabase;
let sqlite: Database | null = null;
let testsBaseUrl: string;

type TErrorEmitter = {
  once?: (event: 'error', listener: (...args: unknown[]) => void) => void;
  on?: (event: 'error', listener: (...args: unknown[]) => void) => void;
};

const onErrorOnce = (
  emitter: unknown,
  listener: (...args: unknown[]) => void
) => {
  if (!emitter || (typeof emitter !== 'object' && typeof emitter !== 'function'))
    return;

  const typedEmitter = emitter as TErrorEmitter;

  if (typeof typedEmitter.once === 'function') {
    typedEmitter.once('error', listener);
    return;
  }

  if (typeof typedEmitter.on === 'function') {
    let called = false;

    typedEmitter.on('error', (...args) => {
      if (called) return;

      called = true;
      listener(...args);
    });
  }
};

const isWebRtcPortAvailable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const tcpServer = createTcpServer();
    tcpServer.unref();

    onErrorOnce(tcpServer, () => {
      resolve(false);
    });

    tcpServer.listen(port, '127.0.0.1', () => {
      const udpSocket = createSocket('udp4');
      udpSocket.unref();

      onErrorOnce(udpSocket, () => {
        udpSocket.close();
        tcpServer.close(() => resolve(false));
      });

      udpSocket.bind(port, '127.0.0.1', () => {
        udpSocket.close(() => {
          tcpServer.close(() => resolve(true));
        });
      });
    });
  });

const getTestWebRtcPort = async (): Promise<number> => {
  for (let i = 0; i < 100; i += 1) {
    const port = 41000 + Math.floor(Math.random() * 20000);

    if (await isWebRtcPortAvailable(port)) {
      return port;
    }
  }

  throw new Error('Failed to find an available WebRTC test port');
};

beforeAll(async () => {
  process.env.SHARKORD_WEBRTC_PORT = String(await getTestWebRtcPort());

  await createHttpServer(9999);
  await loadMediasoup();

  testsBaseUrl = 'http://localhost:9999';
});

beforeEach(async () => {
  clearRateLimitersForTests();

  if (sqlite) {
    try {
      sqlite.close();
    } catch {
      // ignore
    }
  }

  sqlite = new Database(':memory:', { create: true, strict: true });
  sqlite.run('PRAGMA foreign_keys = ON;');

  tdb = drizzle({ client: sqlite });

  // updates the mocked db to use this new test database
  setTestDb(tdb);

  // apply migrations and seed data for this test
  await migrate(tdb, { migrationsFolder: DRIZZLE_PATH });
  await seedDatabase(tdb);
});

afterEach(() => {
  if (sqlite) {
    try {
      sqlite.close();
      sqlite = null;
    } catch {
      // ignore
    }
  }
});

afterAll(async () => {
  if (!CLEANUP_AFTER_FINISH) return;

  try {
    await fs.rm(DATA_PATH, { recursive: true });
  } catch {
    // ignore
  }
});

export { tdb, testsBaseUrl };
