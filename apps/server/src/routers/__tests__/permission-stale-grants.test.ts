import { describe, expect, test } from 'bun:test';
import { Permission } from '@sharkord/shared';
import { and, eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { loadUserGrants } from '../../db/queries/permissions';
import { rolePermissions, userRoles, users } from '../../db/schema';

// Older servers can still hold role_permissions rows for permissions that were
// later removed from the code (for example VIEW_CHANNELS). Role grants compare
// a role's stored permissions with the caller's, so those rows must still count.
describe('stale role permission rows', () => {
	test('are kept in loaded user grants', async () => {
		await initTest(1);
		tdb.insert(rolePermissions).values({ roleId: 2, permission: 'VIEW_CHANNELS', createdAt: Date.now() }).run();

		expect(loadUserGrants(2)?.permissions.has('VIEW_CHANNELS')).toBe(true);
	});

	test('do not stop a moderator granting a role they hold', async () => {
		const { caller: ownerCaller, initialData } = await initTest(1);
		const memberRole = initialData.roles.find((role) => role.isDefault);
		if (!memberRole) throw new Error('Default role not found');
		await ownerCaller.roles.update({
			roleId: memberRole.id,
			name: memberRole.name,
			color: memberRole.color,
			permissions: [...memberRole.permissions, Permission.MANAGE_USERS],
		});
		tdb
			.insert(rolePermissions)
			.values({ roleId: memberRole.id, permission: 'VIEW_CHANNELS', createdAt: Date.now() })
			.run();
		const target = tdb
			.insert(users)
			.values({ name: 'Target', identity: 'target', password: 'x', createdAt: Date.now() })
			.returning()
			.get();

		const { caller: moderatorCaller } = await initTest(2);
		await moderatorCaller.users.addRole({ userId: target.id, roleId: memberRole.id });

		const granted = tdb
			.select()
			.from(userRoles)
			.where(and(eq(userRoles.userId, target.id), eq(userRoles.roleId, memberRole.id)))
			.get();
		expect(granted).toBeDefined();
	});
});
