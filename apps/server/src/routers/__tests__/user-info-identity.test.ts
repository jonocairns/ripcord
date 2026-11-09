import { describe, expect, test } from 'bun:test';
import { Permission } from '@sharkord/shared';
import { initTest } from '../../__tests__/helpers';

describe('users.getInfo identity visibility', () => {
	test('a MANAGE_USERS moderator cannot read the owner login identity', async () => {
		const { caller: ownerCaller, initialData } = await initTest(1);
		const memberRole = initialData.roles.find((role) => role.isDefault);
		if (!memberRole) throw new Error('Default role not found');
		await ownerCaller.roles.update({
			roleId: memberRole.id,
			name: memberRole.name,
			color: memberRole.color,
			permissions: [...memberRole.permissions, Permission.MANAGE_USERS],
		});
		const { caller: moderatorCaller } = await initTest(2);
		const { user } = await moderatorCaller.users.getInfo({ userId: 1 });
		expect(user.identity).toBe('');
		expect(user.password).toBe('');
	});

	test('an Owner can read identities but never password hashes', async () => {
		const { caller } = await initTest(1);
		for (const [userId, identity] of [
			[1, 'testowner'],
			[2, 'testuser'],
		] as const) {
			const { user } = await caller.users.getInfo({ userId });
			expect(user.identity).toBe(identity);
			expect(user.password).toBe('');
		}
	});
});
