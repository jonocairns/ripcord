import { describe, expect, test } from 'bun:test';
import { ChannelPermission, ChannelType, OWNER_ROLE_ID, Permission, type TJoinedRole } from '@sharkord/shared';
import { and, eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { rolePermissions, userRoles, users } from '../../db/schema';

type TCaller = Awaited<ReturnType<typeof initTest>>['caller'];

const OWNER_ID = 1;
const MEMBER_ID = 2;
const GUEST_ROLE_ID = 3;

// Gives the seeded member role extra permissions, turning user 2 into a
// moderator that is not an owner.
const grantMemberPermissions = async (ownerCaller: TCaller, roles: TJoinedRole[], permissions: Permission[]) => {
	const memberRole = roles.find((role) => role.isDefault);

	if (!memberRole) throw new Error('Default role not found');

	await ownerCaller.roles.update({
		roleId: memberRole.id,
		name: memberRole.name,
		color: memberRole.color,
		permissions: [...memberRole.permissions, ...permissions],
	});
};

const initModerator = async (permissions: Permission[]) => {
	const { caller: ownerCaller, initialData } = await initTest(OWNER_ID);

	await grantMemberPermissions(ownerCaller, initialData.roles, permissions);

	const { caller: moderatorCaller } = await initTest(MEMBER_ID);

	return { ownerCaller, moderatorCaller };
};

const hasRole = async (userId: number, roleId: number) => {
	const row = await tdb
		.select()
		.from(userRoles)
		.where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)))
		.get();

	return row !== undefined;
};

describe('owner protection', () => {
	test('a MANAGE_USERS holder cannot assign the owner role', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_USERS]);

		await expect(moderatorCaller.users.addRole({ userId: MEMBER_ID, roleId: OWNER_ROLE_ID })).rejects.toThrow(
			'Only server owners can perform this action',
		);
		expect(await hasRole(MEMBER_ID, OWNER_ROLE_ID)).toBe(false);
	});

	test('a MANAGE_USERS holder cannot remove the owner role from the owner', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_USERS]);

		await expect(moderatorCaller.users.removeRole({ userId: OWNER_ID, roleId: OWNER_ROLE_ID })).rejects.toThrow(
			'Only server owners can perform this action',
		);
		expect(await hasRole(OWNER_ID, OWNER_ROLE_ID)).toBe(true);
	});

	test('a MANAGE_USERS holder cannot change the roles of an owner', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_USERS]);

		await expect(moderatorCaller.users.addRole({ userId: OWNER_ID, roleId: GUEST_ROLE_ID })).rejects.toThrow(
			'Only server owners can perform this action on a server owner',
		);
		expect(await hasRole(OWNER_ID, GUEST_ROLE_ID)).toBe(false);
	});

	test('a MANAGE_USERS holder cannot ban or kick the owner', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_USERS]);

		await expect(moderatorCaller.users.ban({ userId: OWNER_ID })).rejects.toThrow(
			'Only server owners can perform this action on a server owner',
		);
		await expect(moderatorCaller.users.kick({ userId: OWNER_ID })).rejects.toThrow(
			'Only server owners can perform this action on a server owner',
		);

		const owner = await tdb.select({ banned: users.banned }).from(users).where(eq(users.id, OWNER_ID)).get();

		expect(owner?.banned).toBe(false);
	});

	test('a MANAGE_USERS holder can still assign roles within their own permissions', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_USERS]);

		await moderatorCaller.users.addRole({ userId: MEMBER_ID, roleId: GUEST_ROLE_ID });

		expect(await hasRole(MEMBER_ID, GUEST_ROLE_ID)).toBe(true);
	});

	test('a MANAGE_USERS holder cannot assign a role with permissions they lack', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_USERS]);

		await tdb.insert(rolePermissions).values({
			roleId: GUEST_ROLE_ID,
			permission: Permission.MANAGE_SETTINGS,
			createdAt: Date.now(),
		});

		await expect(moderatorCaller.users.addRole({ userId: MEMBER_ID, roleId: GUEST_ROLE_ID })).rejects.toThrow(
			'You cannot assign a role with permissions that you do not have',
		);
		expect(await hasRole(MEMBER_ID, GUEST_ROLE_ID)).toBe(false);
	});

	test('the owner can still assign the owner role', async () => {
		const { caller } = await initTest(OWNER_ID);

		await caller.users.addRole({ userId: MEMBER_ID, roleId: OWNER_ROLE_ID });

		expect(await hasRole(MEMBER_ID, OWNER_ROLE_ID)).toBe(true);
	});
});

describe('role permission escalation', () => {
	test('a MANAGE_ROLES holder cannot grant a permission they lack', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_ROLES]);

		await expect(
			moderatorCaller.roles.update({
				roleId: GUEST_ROLE_ID,
				name: 'Guest',
				color: '#95a5a6',
				permissions: [Permission.MANAGE_USERS],
			}),
		).rejects.toThrow('You cannot grant permissions that you do not have');

		const granted = await tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, GUEST_ROLE_ID));

		expect(granted).toEqual([]);
	});

	test('a MANAGE_ROLES holder can rename a role holding permissions they lack', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_ROLES]);

		await tdb.insert(rolePermissions).values({
			roleId: GUEST_ROLE_ID,
			permission: Permission.MANAGE_SETTINGS,
			createdAt: Date.now(),
		});

		await moderatorCaller.roles.update({
			roleId: GUEST_ROLE_ID,
			name: 'Visitor',
			color: '#95a5a6',
			permissions: [Permission.MANAGE_SETTINGS],
		});

		const granted = await tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, GUEST_ROLE_ID));

		expect(granted.map((row) => row.permission)).toEqual([Permission.MANAGE_SETTINGS]);
	});

	test('updating a missing role is NOT_FOUND', async () => {
		const { caller } = await initTest(OWNER_ID);

		await expect(
			caller.roles.update({ roleId: 999, name: 'Ghost', color: '#000000', permissions: [] }),
		).rejects.toThrow('Role not found');
	});
});

describe('channel permission overrides', () => {
	test('MANAGE_CHANNELS alone cannot change channel permission overrides', async () => {
		const { moderatorCaller } = await initModerator([Permission.MANAGE_CHANNELS]);

		await expect(
			moderatorCaller.channels.updatePermissions({
				channelId: 1,
				userId: MEMBER_ID,
				permissions: [ChannelPermission.VIEW_CHANNEL],
			}),
		).rejects.toThrow('Insufficient permissions');
		await expect(moderatorCaller.channels.deletePermissions({ channelId: 1, userId: MEMBER_ID })).rejects.toThrow(
			'Insufficient permissions',
		);
	});
});

describe('users.getInfo', () => {
	test('never returns the password hash', async () => {
		const { caller } = await initTest(OWNER_ID);

		const { user } = await caller.users.getInfo({ userId: MEMBER_ID });

		expect(user.password).toBe('');
	});

	test('leaves out messages in private channels the caller cannot view', async () => {
		const { ownerCaller, moderatorCaller } = await initModerator([Permission.MANAGE_USERS]);
		const privateChannelId = await ownerCaller.channels.add({ type: ChannelType.TEXT, name: 'secret', categoryId: 1 });

		await ownerCaller.channels.update({ channelId: privateChannelId, private: true });
		await ownerCaller.messages.send({ channelId: privateChannelId, content: 'secret plans', files: [] });

		const { messages } = await moderatorCaller.users.getInfo({ userId: OWNER_ID });

		expect(messages.length).toBeGreaterThan(0);
		expect(messages.some((message) => message.channelId === privateChannelId)).toBe(false);
	});
});
