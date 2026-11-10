import type { Permission, TRole } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { db } from '..';
import { rolePermissions, roles } from '../schema';

const syncRolePermissions = async (roleId: number, permissions: Permission[]): Promise<TRole | undefined> => {
	return await db.transaction((tx) => {
		tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId)).run();

		if (permissions.length > 0) {
			const now = Date.now();
			const permissionInserts = permissions.map((permission) => ({
				roleId,
				permission,
				createdAt: now,
				updatedAt: now,
			}));

			tx.insert(rolePermissions).values(permissionInserts).run();
		}

		const updatedRole = tx.select().from(roles).where(eq(roles.id, roleId)).limit(1).get();

		return updatedRole;
	});
};

export { syncRolePermissions };
