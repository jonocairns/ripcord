import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import { ChannelPermission as C, Permission as P } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { tdb } from '../../__tests__/setup';
import { loadChannelGrants, loadUserGrants } from '../../db/queries/permissions';
import { channels } from '../../db/schema';
import { hasChannelAccess, hasGlobalPermission, resolveChannelGrant, type TUserGrants } from '../permission-policy';

const member: TUserGrants = { banned: false, isOwner: false, permissions: new Set([P.UPLOAD_FILES]) };
const owner: TUserGrants = { ...member, isOwner: true };

test('pure global truth table includes missing, banned owner, arrays and empty grants', () => {
	expect(hasGlobalPermission(undefined, [])).toBe(false);
	expect(hasGlobalPermission({ ...owner, banned: true }, [])).toBe(false);
	expect(hasGlobalPermission(owner, P.JOIN_VOICE_CHANNELS)).toBe(true);
	expect(hasGlobalPermission(member, P.UPLOAD_FILES)).toBe(true);
	expect(hasGlobalPermission(member, [P.UPLOAD_FILES, P.JOIN_VOICE_CHANNELS])).toBe(false);
	expect(hasGlobalPermission(member, [])).toBe(true);
	expect(hasGlobalPermission({ ...member, permissions: new Set() }, [])).toBe(true);
});

test('pure channel precedence preserves early public allow and owner bypass', () => {
	const channel = { private: true, user: [], roles: [] };
	for (const user of [undefined, member, owner, { ...owner, banned: true }]) {
		expect(hasChannelAccess(user, undefined, C.JOIN)).toBe(false);
		expect(hasChannelAccess(user, { ...channel, private: false }, C.JOIN)).toBe(true);
	}
	expect(hasChannelAccess(undefined, channel, C.JOIN)).toBe(false);
	expect(hasChannelAccess({ ...owner, banned: true }, channel, C.JOIN)).toBe(false);
	expect(hasChannelAccess(owner, channel, C.JOIN)).toBe(true);
	expect(hasChannelAccess(member, channel, C.JOIN)).toBe(false);
	const grants = { ...channel, user: [{ permission: C.JOIN, allow: true }] };
	expect(hasChannelAccess(member, grants, C.JOIN)).toBe(false);
	expect(
		hasChannelAccess(
			member,
			{ ...grants, user: [...grants.user, { permission: C.VIEW_CHANNEL, allow: true }] },
			C.JOIN,
		),
	).toBe(true);
	for (const rows of [
		[
			{ permission: C.JOIN, allow: true },
			{ permission: C.JOIN, allow: false },
		],
		[
			{ permission: C.JOIN, allow: false },
			{ permission: C.JOIN, allow: true },
		],
	]) {
		expect(resolveChannelGrant({ ...channel, roles: rows }, C.JOIN)).toBe(true);
		expect(resolveChannelGrant({ ...channel, roles: rows, user: [{ permission: C.JOIN, allow: false }] }, C.JOIN)).toBe(
			false,
		);
		expect(hasChannelAccess(owner, { ...channel, user: [{ permission: C.VIEW_CHANNEL, allow: false }] }, C.JOIN)).toBe(
			true,
		);
	}
});

test('loaders bound queries and filter all channel and user reads to the target', () => {
	tdb.update(channels).set({ private: true }).where(eq(channels.id, 2)).run();
	const prepare = spyOn(Database.prototype, 'prepare');
	try {
		loadUserGrants(2);
		expect(prepare.mock.calls).toHaveLength(2);
		const globalSql = prepare.mock.calls.map(([sql]) => sql);
		expect(globalSql.every((sql) => sql.includes(' where '))).toBe(true);
		expect(globalSql.join(' ')).not.toContain('"files"');
		prepare.mockClear();
		loadChannelGrants(2, 2);
		expect(prepare.mock.calls).toHaveLength(3);
		const sql = prepare.mock.calls.map(([query]) => query);
		expect(sql[0]).toContain('"channels"."id" = ?');
		expect(sql[1]).toContain('"channel_user_permissions"."channel_id" = ?');
		expect(sql[1]).toContain('"channel_user_permissions"."user_id" = ?');
		expect(sql[2]).toContain('"channel_role_permissions"."channel_id" = ?');
		expect(sql[2]).toContain('"user_roles"."user_id" = ?');
		prepare.mockClear();
		loadChannelGrants(2, 1);
		expect(prepare.mock.calls).toHaveLength(1);
	} finally {
		prepare.mockRestore();
	}
});
