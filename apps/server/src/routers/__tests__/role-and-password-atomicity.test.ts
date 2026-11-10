import { describe, expect, spyOn, test } from 'bun:test';
import { OWNER_ROLE_ID, Permission } from '@sharkord/shared';
import { eq, sql } from 'drizzle-orm';
import { initTest, login } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { syncRolePermissions } from '../../db/mutations/roles';
import { fallbackUsersToDefaultRole } from '../../db/mutations/users';
import * as channelQueries from '../../db/queries/channels';
import { refreshTokens, rolePermissions, roles, userRoles, users } from '../../db/schema';
import * as passwordHelpers from '../../helpers/password';

const passwordInput = {
	currentPassword: 'password123',
	newPassword: 'newpassword123',
	confirmNewPassword: 'newpassword123',
	renewSession: true,
};

const credentialState = () => ({
	user: tdb.select().from(users).where(eq(users.id, 2)).get(),
	tokens: tdb.select().from(refreshTokens).where(eq(refreshTokens.userId, 2)).all(),
});

describe('password and role atomicity', () => {
	for (const revoke of [false, true]) {
		test(`password change rejects a competing version bump (revoked token: ${revoke})`, async () => {
			const response = await login('testuser', 'password123');
			expect(response.status).toBe(200);
			await response.text();
			const { caller } = await initTest(2);
			expect(credentialState().tokens).toHaveLength(1);
			expect(credentialState().tokens[0]?.revokedAt).toBeNull();
			let competingState: ReturnType<typeof credentialState> | undefined;
			const originalHash = passwordHelpers.hashPassword;
			const hashSpy = spyOn(passwordHelpers, 'hashPassword').mockImplementation(async (password) => {
				const hash = await originalHash(password);
				tdb
					.update(users)
					.set({ tokenVersion: sql`${users.tokenVersion} + 1` })
					.where(eq(users.id, 2))
					.run();
				if (revoke) {
					tdb.update(refreshTokens).set({ revokedAt: 123, updatedAt: 123 }).where(eq(refreshTokens.userId, 2)).run();
				}
				competingState = credentialState();
				return hash;
			});
			try {
				const result = await caller.users.updatePassword(passwordInput).then(
					(credentials) => ({ credentials, error: undefined }),
					(error: unknown) => ({ credentials: undefined, error }),
				);
				expect(result.error).toMatchObject({
					code: 'CONFLICT',
					message: 'Your session changed while updating the password. Please sign in and try again.',
				});
				expect(result.credentials).toBeUndefined();
				if (!competingState) throw new Error('Competing operation did not run');
				expect(credentialState()).toEqual(competingState);
			} finally {
				hashSpy.mockRestore();
			}
		});
	}

	test('password change reports a user deleted during hashing as not found', async () => {
		const { caller } = await initTest(2);
		const originalHash = passwordHelpers.hashPassword;
		const hashSpy = spyOn(passwordHelpers, 'hashPassword').mockImplementation(async (password) => {
			const hash = await originalHash(password);
			tdb.delete(users).where(eq(users.id, 2)).run();
			return hash;
		});
		try {
			await expect(caller.users.updatePassword(passwordInput)).rejects.toMatchObject({
				code: 'NOT_FOUND',
				message: 'User not found',
			});
		} finally {
			hashSpy.mockRestore();
		}
	});

	test('failed permission replacement rolls back the role name, color and permissions', async () => {
		const { caller } = await initTest();
		const before = tdb.select().from(roles).where(eq(roles.id, 2)).get();
		const permissions = tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, 2)).all();
		tdb.run(
			sql.raw(
				"CREATE TRIGGER fail_permissions BEFORE INSERT ON role_permissions BEGIN SELECT RAISE(ABORT, 'forced'); END;",
			),
		);
		await expect(
			caller.roles.update({
				roleId: 2,
				name: 'Changed member',
				color: '#123456',
				permissions: [Permission.SEND_MESSAGES],
			}),
		).rejects.toThrow('forced');
		expect(tdb.select().from(roles).where(eq(roles.id, 2)).get()).toEqual(before);
		expect(tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, 2)).all()).toEqual(permissions);
	});

	test('missing role update result is reported without syncing permissions', async () => {
		const { caller } = await initTest();
		const permissions = tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, 2)).all();
		tdb.run(sql.raw('CREATE TRIGGER ignore_role_update BEFORE UPDATE ON roles BEGIN SELECT RAISE(IGNORE); END;'));
		await expect(
			caller.roles.update({
				roleId: 2,
				name: 'Ignored',
				color: '#123456',
				permissions: [],
			}),
		).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Role not found' });
		expect(tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, 2)).all()).toEqual(permissions);
	});

	test('awaitable permission wrapper replaces grants and rolls back failed replacements', async () => {
		const updated = await syncRolePermissions(2, [Permission.SEND_MESSAGES]);
		expect(updated?.id).toBe(2);
		const permissions = tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, 2)).all();
		expect(permissions.map((row) => row.permission)).toEqual([Permission.SEND_MESSAGES]);
		tdb.run(
			sql.raw(
				"CREATE TRIGGER fail_wrapper BEFORE INSERT ON role_permissions BEGIN SELECT RAISE(ABORT, 'forced'); END;",
			),
		);
		await expect(syncRolePermissions(2, [Permission.MANAGE_ROLES])).rejects.toThrow('forced');
		expect(tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, 2)).all()).toEqual(permissions);
	});

	test('awaitable fallback wrapper resolves the current default and preserves other roles', async () => {
		const { caller } = await initTest();
		const roleId = await caller.roles.add();
		tdb.insert(userRoles).values({ userId: 2, roleId, createdAt: 1 }).run();
		await fallbackUsersToDefaultRole(roleId);
		expect(
			tdb
				.select()
				.from(userRoles)
				.where(eq(userRoles.userId, 2))
				.all()
				.map((row) => row.roleId),
		).toEqual([2]);
		expect(tdb.select().from(roles).where(eq(roles.id, roleId)).get()).toBeDefined();
	});

	test('owner role metadata changes without replacing its permissions', async () => {
		const { caller } = await initTest();
		const permissions = tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, OWNER_ROLE_ID)).all();
		await caller.roles.update({ roleId: OWNER_ROLE_ID, name: 'Renamed owner', color: '#123456', permissions: [] });
		expect(tdb.select().from(roles).where(eq(roles.id, OWNER_ROLE_ID)).get()).toMatchObject({
			name: 'Renamed owner',
			color: '#123456',
		});
		expect(tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, OWNER_ROLE_ID)).all()).toEqual(
			permissions,
		);
	});

	test('role deletion is refused if the role becomes the default during the request', async () => {
		const { caller } = await initTest();
		const roleId = await caller.roles.add();
		tdb.insert(userRoles).values({ userId: 2, roleId, createdAt: 1 }).run();
		const original = channelQueries.getVisibleChannelIdsByUserSync;
		// Runs after the route's up-front checks and before its transaction.
		const spy = spyOn(channelQueries, 'getVisibleChannelIdsByUserSync').mockImplementation((userIds) => {
			tdb.update(roles).set({ isDefault: false }).run();
			tdb.update(roles).set({ isDefault: true }).where(eq(roles.id, roleId)).run();
			return original(userIds);
		});
		try {
			await expect(caller.roles.delete({ roleId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
		} finally {
			spy.mockRestore();
		}
		expect(tdb.select().from(roles).where(eq(roles.id, roleId)).get()?.isDefault).toBe(true);
		expect(tdb.select().from(userRoles).where(eq(userRoles.roleId, roleId)).all()).toHaveLength(1);
	});

	for (const failDelete of [true, false]) {
		test(`role deletion preserves fallback semantics (rollback: ${failDelete})`, async () => {
			const { caller } = await initTest();
			const roleId = await caller.roles.add();
			const extraRoleId = await caller.roles.add();
			// User 1 already has default plus another role; user 2 only has the deleted role plus another role.
			tdb.delete(userRoles).where(eq(userRoles.userId, 2)).run();
			tdb
				.insert(userRoles)
				.values([
					{ userId: 1, roleId: 2, createdAt: 1 },
					{ userId: 1, roleId, createdAt: 1 },
					{ userId: 2, roleId, createdAt: 1 },
					{ userId: 2, roleId: extraRoleId, createdAt: 1 },
				])
				.run();
			const before = tdb.select().from(userRoles).all();
			if (failDelete) {
				tdb.run(sql.raw("CREATE TRIGGER fail_delete BEFORE DELETE ON roles BEGIN SELECT RAISE(ABORT, 'forced'); END;"));
				await expect(caller.roles.delete({ roleId })).rejects.toThrow('forced');
				expect(tdb.select().from(userRoles).all()).toEqual(before);
				expect(tdb.select().from(roles).where(eq(roles.id, roleId)).get()).toBeDefined();
			} else {
				await caller.roles.delete({ roleId });
				expect(tdb.select().from(roles).where(eq(roles.id, roleId)).get()).toBeUndefined();
				const remaining = tdb.select().from(userRoles).all();
				expect(remaining.filter((row) => row.roleId === roleId)).toHaveLength(0);
				for (const userId of [1, 2]) {
					expect(remaining.filter((row) => row.userId === userId && row.roleId === 2)).toHaveLength(1);
				}
				expect(remaining.some((row) => row.userId === 1 && row.roleId === OWNER_ROLE_ID)).toBe(true);
				expect(remaining.some((row) => row.userId === 2 && row.roleId === extraRoleId)).toBe(true);
			}
		});
	}
});
