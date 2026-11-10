import { describe, expect, test } from 'bun:test';
import { ChannelPermission, ChannelType, Permission } from '@sharkord/shared';
import { asc, eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { channelRolePermissions, channels, channelUserPermissions } from '../../db/schema';

const initModerator = async () => {
	const { caller: ownerCaller, initialData } = await initTest(1);
	const memberRole = initialData.roles.find((role) => role.isDefault);
	if (!memberRole) throw new Error('Default role not found');
	await ownerCaller.roles.update({
		roleId: memberRole.id,
		name: memberRole.name,
		color: memberRole.color,
		permissions: [...memberRole.permissions, Permission.MANAGE_CHANNELS, Permission.MANAGE_CHANNEL_PERMISSIONS],
	});
	const { caller: moderatorCaller } = await initTest(2);
	return { ownerCaller, moderatorCaller, memberRoleId: memberRole.id };
};

const initCategory = async () => {
	const callers = await initModerator();
	const privateId = await callers.ownerCaller.channels.add({ type: ChannelType.TEXT, name: 'P', categoryId: 1 });
	await callers.ownerCaller.channels.update({ channelId: privateId, private: true });
	const lastId = await callers.ownerCaller.channels.add({ type: ChannelType.TEXT, name: 'B', categoryId: 1 });
	return { ...callers, privateId, lastId };
};

const categoryPositions = (categoryId: number) =>
	tdb
		.select({ id: channels.id, position: channels.position })
		.from(channels)
		.where(eq(channels.categoryId, categoryId))
		.orderBy(asc(channels.position), asc(channels.id))
		.all();

const permissionRows = () => ({
	user: tdb.select().from(channelUserPermissions).all(),
	role: tdb.select().from(channelRolePermissions).all(),
});

describe('private channel management guards', () => {
	for (const includeHidden of [false, true]) {
		test(`reorder preserves hidden slots with hidden id ${includeHidden ? 'included' : 'omitted'}`, async () => {
			const { moderatorCaller, privateId, lastId } = await initCategory();
			await moderatorCaller.channels.reorder({
				categoryId: 1,
				channelIds: includeHidden ? [privateId, lastId, 1] : [lastId, 1],
			});
			expect(categoryPositions(1)).toEqual([
				{ id: lastId, position: 1 },
				{ id: privateId, position: 2 },
				{ id: 1, position: 3 },
			]);
		});
	}

	test('reorder ignores other categories, unknown and duplicate ids and appends omitted visible channels', async () => {
		const { moderatorCaller, privateId, lastId } = await initCategory();
		const otherCategory = categoryPositions(2);
		await moderatorCaller.channels.reorder({ categoryId: 1, channelIds: [2, 999, lastId, lastId] });
		expect(categoryPositions(1)).toEqual([
			{ id: lastId, position: 1 },
			{ id: privateId, position: 2 },
			{ id: 1, position: 3 },
		]);
		expect(categoryPositions(2)).toEqual(otherCategory);
	});

	test('owner can reorder private channels and the fully visible shipped payload keeps its order', async () => {
		const { ownerCaller, moderatorCaller, privateId, lastId } = await initCategory();
		await ownerCaller.channels.reorder({ categoryId: 1, channelIds: [lastId, 1, privateId] });
		expect(categoryPositions(1)).toEqual([
			{ id: lastId, position: 1 },
			{ id: 1, position: 2 },
			{ id: privateId, position: 3 },
		]);
		await ownerCaller.channels.updatePermissions({
			channelId: privateId,
			userId: 2,
			permissions: [ChannelPermission.VIEW_CHANNEL],
		});
		await moderatorCaller.channels.reorder({ categoryId: 1, channelIds: [privateId, lastId, 1] });
		expect(categoryPositions(1)).toEqual([
			{ id: privateId, position: 1 },
			{ id: lastId, position: 2 },
			{ id: 1, position: 3 },
		]);
	});

	for (const target of ['user', 'role'] as const) {
		for (const operation of ['get', 'update', 'delete'] as const) {
			test(`${operation} permissions rejects hidden private channels for ${target} rows without changing grants`, async () => {
				const { ownerCaller, moderatorCaller, privateId, memberRoleId } = await initCategory();
				await ownerCaller.channels.updatePermissions({ channelId: privateId, userId: 2, permissions: [] });
				await ownerCaller.channels.updatePermissions({
					channelId: privateId,
					roleId: memberRoleId,
					permissions: [ChannelPermission.VIEW_CHANNEL],
				});
				const before = permissionRows();
				const input = { channelId: privateId, ...(target === 'user' ? { userId: 2 } : { roleId: memberRoleId }) };
				const request =
					operation === 'get'
						? moderatorCaller.channels.getPermissions(input)
						: operation === 'update'
							? moderatorCaller.channels.updatePermissions({ ...input, permissions: [ChannelPermission.VIEW_CHANNEL] })
							: moderatorCaller.channels.deletePermissions(input);
				await expect(request).rejects.toMatchObject({ code: 'FORBIDDEN' });
				expect(permissionRows()).toEqual(before);
			});
		}
	}

	for (const actor of ['owner', 'viewer', 'public moderator'] as const) {
		test(`${actor} can read, update and delete permissions`, async () => {
			const { ownerCaller, moderatorCaller, privateId, memberRoleId } = await initCategory();
			if (actor === 'viewer')
				await ownerCaller.channels.updatePermissions({
					channelId: privateId,
					userId: 2,
					permissions: [ChannelPermission.VIEW_CHANNEL],
				});
			const caller = actor === 'owner' ? ownerCaller : moderatorCaller;
			const channelId = actor === 'public moderator' ? 1 : privateId;
			for (const target of [{ userId: 1 }, { roleId: memberRoleId }]) {
				await caller.channels.updatePermissions({
					channelId,
					...target,
					permissions: [ChannelPermission.VIEW_CHANNEL],
				});
				const grants = await caller.channels.getPermissions({ channelId });
				expect(target.userId ? grants.userPermissions : grants.rolePermissions).toContainEqual(
					expect.objectContaining({ channelId, ...target, permission: ChannelPermission.VIEW_CHANNEL, allow: true }),
				);
				await caller.channels.deletePermissions({ channelId, ...target });
				const remaining = await caller.channels.getPermissions({ channelId });
				expect(target.userId ? remaining.userPermissions : remaining.rolePermissions).not.toContainEqual(
					expect.objectContaining(target),
				);
			}
		});
	}

	for (const operation of ['get', 'update', 'delete'] as const) {
		test(`${operation} permissions reports missing channel`, async () => {
			const { moderatorCaller } = await initModerator();
			const input = { channelId: 999, userId: 2 };
			const request =
				operation === 'get'
					? moderatorCaller.channels.getPermissions(input)
					: operation === 'update'
						? moderatorCaller.channels.updatePermissions(input)
						: moderatorCaller.channels.deletePermissions(input);
			await expect(request).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Channel not found' });
		});
	}
});
