import { and, eq } from 'drizzle-orm';
import { invariant } from '../../utils/invariant';
import { db } from '..';
import { getDefaultRole } from '../queries/roles';
import { userRoles } from '../schema';

type TUserRoleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const fallbackUsersToDefaultRoleSync = (tx: TUserRoleTransaction, roleId: number, defaultRoleId: number): void => {
	const affectedUsers = tx
		.select({ userId: userRoles.userId })
		.from(userRoles)
		.where(eq(userRoles.roleId, roleId))
		.all();

	tx.delete(userRoles).where(eq(userRoles.roleId, roleId)).run();

	for (const { userId } of affectedUsers) {
		const hasDefaultRole = tx
			.select()
			.from(userRoles)
			.where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, defaultRoleId)))
			.limit(1)
			.all();

		if (hasDefaultRole.length === 0) {
			tx.insert(userRoles)
				.values({
					userId,
					roleId: defaultRoleId,
					createdAt: Date.now(),
				})
				.run();
		}
	}
};

const fallbackUsersToDefaultRole = async (roleId: number) => {
	const defaultRole = await getDefaultRole();

	invariant(defaultRole, {
		code: 'NOT_FOUND',
		message: 'Default role not found',
	});

	db.transaction((tx) => fallbackUsersToDefaultRoleSync(tx, roleId, defaultRole.id));
};

export { fallbackUsersToDefaultRole, fallbackUsersToDefaultRoleSync };
