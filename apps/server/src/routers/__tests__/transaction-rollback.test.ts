import { describe, expect, test } from 'bun:test';
import { ChannelPermission, ChannelType, Permission } from '@sharkord/shared';
import { eq, sql } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { channels, channelUserPermissions, rolePermissions, roles, userRoles } from '../../db/schema';

describe('transaction rollback', () => {
	test('keeps channel permission rows when replacement fails', async () => {
		const { caller } = await initTest();
		await caller.channels.updatePermissions({
			channelId: 1,
			userId: 2,
			permissions: [ChannelPermission.VIEW_CHANNEL],
		});
		const original = tdb.select().from(channelUserPermissions).all();
		expect(original.length).toBeGreaterThan(0);
		tdb.run(
			sql.raw(
				"CREATE TRIGGER fail_permissions BEFORE INSERT ON channel_user_permissions BEGIN SELECT RAISE(ABORT, 'forced'); END;",
			),
		);

		await expect(
			caller.channels.updatePermissions({
				channelId: 1,
				userId: 2,
				permissions: [],
			}),
		).rejects.toThrow('forced');

		expect(tdb.select().from(channelUserPermissions).all()).toEqual(original);
	});

	test('keeps the previous default role when setting the new default fails', async () => {
		const { caller } = await initTest();
		const roleId = await caller.roles.add();
		const original = tdb.select().from(roles).where(eq(roles.isDefault, true)).all();
		expect(original).toHaveLength(1);
		tdb.run(
			sql.raw(
				"CREATE TRIGGER fail_default BEFORE UPDATE OF is_default ON roles WHEN NEW.is_default = 1 BEGIN SELECT RAISE(ABORT, 'forced'); END;",
			),
		);

		await expect(caller.roles.setDefault({ roleId })).rejects.toThrow('forced');

		expect(tdb.select().from(roles).where(eq(roles.isDefault, true)).all()).toEqual(original);
	});

	test('keeps the first channel position when reordering the second fails', async () => {
		const { caller } = await initTest();
		const secondId = await caller.channels.add({ categoryId: 1, name: 'Second', type: ChannelType.TEXT });
		const original = tdb.select().from(channels).where(eq(channels.categoryId, 1)).all();
		expect(original).toHaveLength(2);
		tdb.run(
			sql.raw(
				`CREATE TRIGGER fail_reorder BEFORE UPDATE ON channels WHEN NEW.id = ${secondId} BEGIN SELECT RAISE(ABORT, 'forced'); END;`,
			),
		);

		await expect(caller.channels.reorder({ categoryId: 1, channelIds: [1, secondId] })).rejects.toThrow('forced');

		expect(tdb.select().from(channels).where(eq(channels.categoryId, 1)).all()).toEqual(original);
	});

	test('keeps role permissions when replacement fails', async () => {
		const { caller } = await initTest();
		const original = tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, 2)).all();
		expect(original.length).toBeGreaterThan(0);
		tdb.run(
			sql.raw(
				"CREATE TRIGGER fail_role_permissions BEFORE INSERT ON role_permissions BEGIN SELECT RAISE(ABORT, 'forced'); END;",
			),
		);

		await expect(
			caller.roles.update({
				roleId: 2,
				name: 'Member',
				color: '#99aab5',
				permissions: [Permission.SEND_MESSAGES],
			}),
		).rejects.toThrow('forced');

		expect(tdb.select().from(rolePermissions).where(eq(rolePermissions.roleId, 2)).all()).toEqual(original);
	});

	test('keeps the original user role when fallback assignment fails', async () => {
		const { caller } = await initTest();
		const roleId = await caller.roles.add();
		tdb.delete(userRoles).where(eq(userRoles.userId, 2)).run();
		tdb.insert(userRoles).values({ userId: 2, roleId, createdAt: Date.now() }).run();
		const original = tdb.select().from(userRoles).where(eq(userRoles.userId, 2)).all();
		tdb.run(
			sql.raw("CREATE TRIGGER fail_user_roles BEFORE INSERT ON user_roles BEGIN SELECT RAISE(ABORT, 'forced'); END;"),
		);

		await expect(caller.roles.delete({ roleId })).rejects.toThrow('forced');

		expect(tdb.select().from(userRoles).where(eq(userRoles.userId, 2)).all()).toEqual(original);
		expect(tdb.select().from(roles).where(eq(roles.id, roleId)).get()).toBeDefined();
	});
});
