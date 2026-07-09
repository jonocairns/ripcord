// Idempotently ensure a dedicated, voice-capable e2e peer exists in the dev DB.
//
// Why this is needed: in this dev database the voice channels are public, but the
// CLIENT's useCan() only grants JOIN_VOICE_CHANNELS to owners or to roles whose
// permissions are loaded for the *own* user — and freshly auto-registered users
// never get there (they stay aria-disabled on every voice channel, even after a
// re-login). The only reliably voice-capable identity is an Owner. So we seed one.
//
// This TOUCHES apps/server/data/db.sqlite. It is additive and reversible:
//   bun run helpers/seed-peer.ts --remove
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { E2E_PEER } from './peer-creds';

// e2e-spike/helpers → repo root → apps/server/data/db.sqlite
const DB_PATH = path.resolve(import.meta.dir, '../../apps/server/data/db.sqlite');
const OWNER_ROLE_ID = 1;

const ARGON2_PREFIX = 'argon2$';
const hashPassword = async (password: string) =>
	`${ARGON2_PREFIX}${await Bun.password.hash(password, { algorithm: 'argon2id' })}`;

async function ensurePeer(remove = false) {
	const db = new Database(DB_PATH);
	const existing = db.query('SELECT id FROM users WHERE identity = ?').get(E2E_PEER.identity) as
		| { id: number }
		| undefined;

	if (remove) {
		if (existing) {
			db.run('DELETE FROM user_roles WHERE user_id = ?', [existing.id]);
			db.run('DELETE FROM users WHERE id = ?', [existing.id]);
			console.log(`removed e2e peer id=${existing.id}`);
		} else {
			console.log('no e2e peer to remove');
		}
		db.close();
		return;
	}

	if (existing) {
		console.log(`e2e peer already present id=${existing.id}`);
		db.close();
		return existing.id;
	}

	const now = Date.now();
	const password = await hashPassword(E2E_PEER.password);
	db.run(
		'INSERT INTO users (identity, password, name, last_login_at, created_at) VALUES (?, ?, ?, ?, ?)',
		[E2E_PEER.identity, password, E2E_PEER.name, now, now],
	);
	const id = (db.query('SELECT id FROM users WHERE identity = ?').get(E2E_PEER.identity) as { id: number }).id;
	db.run('INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)', [id, OWNER_ROLE_ID, now]);
	console.log(`seeded e2e peer id=${id} with Owner role`);
	db.close();
	return id;
}

export { ensurePeer };
