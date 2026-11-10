import { Database } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import { ChannelPermission as C, Permission as P } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken, uploadFile } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { getAllChannelUserPermissions } from '../../db/queries/channels';
import {
	channelRolePermissions,
	channels,
	channelUserPermissions,
	rolePermissions,
	roles,
	userRoles,
	users,
} from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { revalidateActiveVoiceSessions } from '../../utils/revalidate-voice-sessions';
import { isOwner, requireOwner } from '../users/require-owner';

const context = async (id: number) => createMockContext({ customToken: await getMockedToken(id) });
const privateChannel = () => tdb.update(channels).set({ private: true }).where(eq(channels.id, 2)).run();
const userGrant = (userId: number, permission: C, allow: boolean) =>
	tdb.insert(channelUserPermissions).values({ channelId: 2, userId, permission, allow, createdAt: 0 }).run();

describe('main permission characterization', () => {
	test('global grants require roles, arrays require every grant, empty arrays allow valid users', async () => {
		const member = await context(2);
		tdb.delete(rolePermissions).run();
		expect(await member.hasPermission(P.UPLOAD_FILES)).toBe(false);
		expect(await member.hasPermission([])).toBe(true);
		const role = tdb.select().from(userRoles).where(eq(userRoles.userId, 2)).get();
		if (!role) throw new Error('Missing seeded member role');
		tdb.insert(rolePermissions).values({ roleId: role.roleId, permission: P.UPLOAD_FILES, createdAt: 0 }).run();
		expect(await member.hasPermission(P.UPLOAD_FILES)).toBe(true);
		expect(await member.hasPermission([P.UPLOAD_FILES, P.JOIN_VOICE_CHANNELS])).toBe(false);
		expect(await (await context(1)).hasPermission([P.UPLOAD_FILES, P.JOIN_VOICE_CHANNELS])).toBe(true);
		tdb.delete(userRoles).where(eq(userRoles.userId, 2)).run();
		expect(await member.hasPermission(P.UPLOAD_FILES)).toBe(false);
		expect(await member.hasPermission([])).toBe(true);
	});

	test('channel ordering: missing, public, view gate, explicit user override, owner', async () => {
		const member = await context(2);
		expect(await member.hasChannelPermission(999, C.JOIN)).toBe(false);
		expect(await member.hasChannelPermission(2, C.JOIN)).toBe(true);
		privateChannel();
		expect(await member.hasChannelPermission(2, C.JOIN)).toBe(false);
		userGrant(2, C.JOIN, true);
		expect(await member.hasChannelPermission(2, C.JOIN)).toBe(false);
		userGrant(2, C.VIEW_CHANNEL, true);
		expect(await member.hasChannelPermission(2, C.JOIN)).toBe(true);
		tdb.delete(userRoles).where(eq(userRoles.userId, 2)).run();
		expect(await member.hasChannelPermission(2, C.JOIN)).toBe(true);
		userGrant(1, C.VIEW_CHANNEL, false);
		userGrant(1, C.JOIN, false);
		expect(await (await context(1)).hasChannelPermission(2, C.JOIN)).toBe(true);
		tdb.delete(channelUserPermissions).run();
		userGrant(2, C.VIEW_CHANNEL, true);
		expect(await member.hasChannelPermission(2, C.JOIN)).toBe(false);
	});

	for (const reverse of [false, true])
		test(`role allows beat role denies in either row order: ${reverse}`, async () => {
			const member = await context(2);
			privateChannel();
			tdb.delete(userRoles).where(eq(userRoles.userId, 2)).run();
			const ids = [10, 11];
			for (const id of ids) {
				tdb
					.insert(roles)
					.values({ id, name: `Role ${id}`, color: '#ffffff', isPersistent: false, isDefault: false, createdAt: 0 })
					.run();
				tdb.insert(userRoles).values({ userId: 2, roleId: id, createdAt: 0 }).run();
			}
			for (const id of reverse ? ids.toReversed() : ids)
				for (const permission of [C.VIEW_CHANNEL, C.JOIN]) {
					tdb
						.insert(channelRolePermissions)
						.values({ channelId: 2, roleId: id, permission, allow: id === 10, createdAt: 0 })
						.run();
				}
			expect(await member.hasChannelPermission(2, C.JOIN)).toBe(true);
			userGrant(2, C.JOIN, false);
			expect(await member.hasChannelPermission(2, C.JOIN)).toBe(false);
		});

	test('deleted user denies globally and privately but public still allows', async () => {
		const member = await context(2);
		tdb.delete(users).where(eq(users.id, 2)).run();
		expect(await member.hasPermission([])).toBe(false);
		expect(await member.hasChannelPermission(2, C.JOIN)).toBe(true);
		privateChannel();
		expect(await member.hasChannelPermission(2, C.JOIN)).toBe(false);
	});

	test('require-owner checks role independently of ban and retains error text', async () => {
		const owner = await context(1);
		const member = await context(2);
		await requireOwner(owner);
		await expect(requireOwner(member)).rejects.toMatchObject({
			code: 'FORBIDDEN',
			message: 'Only server owners can perform this action',
		});
		tdb.update(users).set({ banned: true }).where(eq(users.id, 1)).run();
		expect(await isOwner(1)).toBe(true);
		await requireOwner(owner);
		expect(await isOwner(999)).toBe(false);
	});

	test('upload permission denial retains HTTP status and body; owner bypasses missing grants', async () => {
		tdb.delete(rolePermissions).run();
		const file = new File(['parity'], 'parity.txt', { type: 'text/plain' });
		const denied = await uploadFile(file, await getMockedToken(2));
		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({ error: 'You do not have permission to upload files' });
		const allowed = await uploadFile(file, await getMockedToken(1));
		expect(allowed.status).toBe(200);
		tdb.update(users).set({ banned: true }).where(eq(users.id, 2)).run();
		const banned = await uploadFile(file, await getMockedToken(2));
		expect(banned.status).toBe(403);
		expect(await banned.json()).toEqual({ error: 'User is banned' });
	});
});

test('existing voice revalidation follows global join and channel join, not speak', async () => {
	const member = await context(2);
	const runtime = new VoiceRuntime(2);
	await runtime.init();
	try {
		privateChannel();
		userGrant(2, C.VIEW_CHANNEL, true);
		userGrant(2, C.JOIN, true);
		runtime.addUser(2, { micMuted: false, soundMuted: false });
		expect(await member.hasPermission(P.JOIN_VOICE_CHANNELS)).toBe(true);
		expect(await member.hasChannelPermission(2, C.JOIN)).toBe(true);
		expect(await member.hasChannelPermission(2, C.SPEAK)).toBe(false);
		await revalidateActiveVoiceSessions();
		expect(runtime.getUser(2)).toBeDefined();
		tdb.delete(channelUserPermissions).run();
		expect(await member.hasChannelPermission(2, C.JOIN)).toBe(false);
		await revalidateActiveVoiceSessions();
		expect(runtime.getUser(2)).toBeUndefined();
	} finally {
		runtime.removeUser(2);
		await runtime.destroy();
	}
});

test('intentional hardening: an existing context denies newly banned members and owners', async () => {
	for (const id of [1, 2]) {
		const ctx = await context(id);
		userGrant(id, C.VIEW_CHANNEL, true);
		userGrant(id, C.JOIN, true);
		tdb.update(users).set({ banned: true }).where(eq(users.id, id)).run();
		expect(await ctx.hasPermission([])).toBe(false);
		expect(await ctx.hasChannelPermission(2, C.JOIN)).toBe(true);
		privateChannel();
		expect(await ctx.hasChannelPermission(2, C.JOIN)).toBe(false);
		tdb.update(channels).set({ private: false }).where(eq(channels.id, 2)).run();
		expect(await isOwner(id)).toBe(id === 1);
	}
});

test('channel checker is a per-operation snapshot and reloads subsequent operations', async () => {
	const ctx = await context(2);
	privateChannel();
	userGrant(2, C.VIEW_CHANNEL, true);
	userGrant(2, C.JOIN, true);
	const prepare = spyOn(Database.prototype, 'prepare');
	let can;
	try {
		can = ctx.createChannelPermissionChecker(2);
		expect(prepare.mock.calls).toHaveLength(5);
		can(C.SPEAK);
		can(C.WEBCAM);
		can(C.SHARE_SCREEN);
		expect(prepare.mock.calls).toHaveLength(5);
	} finally {
		prepare.mockRestore();
	}
	expect(can(C.JOIN)).toBe(true);
	tdb.delete(channelUserPermissions).run();
	expect(can(C.JOIN)).toBe(true);
	expect(ctx.createChannelPermissionChecker(2)(C.JOIN)).toBe(false);
});

test('public channel access does not change the raw bulk permission map', async () => {
	const ctx = await context(2);
	const map = await getAllChannelUserPermissions(2);
	expect(await ctx.hasChannelPermission(2, C.JOIN)).toBe(true);
	expect(map[2]?.permissions[C.JOIN]).toBe(false);
});

for (const id of [1, 2])
	test(`voice revalidation denies a banned seated user, including owner: ${id}`, async () => {
		const ctx = await context(id);
		const runtime = new VoiceRuntime(2);
		await runtime.init();
		try {
			runtime.addUser(id, { micMuted: false, soundMuted: false });
			tdb.update(users).set({ banned: true }).where(eq(users.id, id)).run();
			expect(await ctx.hasPermission(P.JOIN_VOICE_CHANNELS)).toBe(false);
			await revalidateActiveVoiceSessions();
			expect(runtime.getUser(id)).toBeUndefined();
		} finally {
			runtime.removeUser(id);
			await runtime.destroy();
		}
	});
