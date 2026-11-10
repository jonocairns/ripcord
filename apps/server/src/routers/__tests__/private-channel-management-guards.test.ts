import { describe, expect, test } from 'bun:test';
import { ChannelPermission, ChannelType, Permission, ServerEvents } from '@sharkord/shared';
import { asc, eq } from 'drizzle-orm';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken, initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { channelRolePermissions, channels, channelUserPermissions, rolePermissions, users } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { appRouter } from '..';

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
	// Explicit positions make the hidden-id-first regression move P on main.
	for (const [id, position] of [
		[1, 1],
		[privateId, 2],
		[lastId, 3],
	] as const)
		tdb.update(channels).set({ position }).where(eq(channels.id, id)).run();
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
	for (const mutation of ['move', 'delete', 'add', 'privacy', 'revoke'] as const) {
		test(`reorder uses current membership and authorization after suspended lookup: ${mutation}`, async () => {
			const { ownerCaller, privateId, lastId } = await initCategory();
			const ctx = await createMockContext({ customToken: await getMockedToken(2) });
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const caller = appRouter.createCaller({
				...ctx,
				needsPermission: async (permission) => {
					await ctx.needsPermission(permission);
					entered.resolve();
					await release.promise;
				},
			});
			const { handshakeHash } = await caller.others.handshake();
			await caller.others.joinServer({ handshakeHash });
			const request = caller.channels.reorder({ categoryId: 1, channelIds: [lastId, 1] });
			await entered.promise;
			let addedId: number | undefined;
			if (mutation === 'move')
				tdb.update(channels).set({ categoryId: 2, position: 7 }).where(eq(channels.id, lastId)).run();
			if (mutation === 'delete') tdb.delete(channels).where(eq(channels.id, lastId)).run();
			if (mutation === 'privacy') tdb.update(channels).set({ private: true }).where(eq(channels.id, lastId)).run();
			if (mutation === 'revoke') tdb.delete(rolePermissions).run();
			if (mutation === 'add') {
				addedId = await ownerCaller.channels.add({ name: 'New', type: ChannelType.TEXT, categoryId: 1 });
				tdb.update(channels).set({ position: 0 }).where(eq(channels.id, addedId)).run();
			}
			const before = categoryPositions(1);
			release.resolve();
			if (mutation === 'revoke') {
				await expect(request).rejects.toMatchObject({ code: 'FORBIDDEN' });
				expect(categoryPositions(1)).toEqual(before);
				return;
			}
			await request;
			if (mutation === 'add' && addedId === undefined) throw new Error('New member missing');
			const expectedIds =
				mutation === 'move' || mutation === 'delete'
					? [1, privateId]
					: mutation === 'add' && addedId !== undefined
						? [lastId, 1, privateId, addedId]
						: [1, privateId, lastId];
			expect(categoryPositions(1)).toEqual(expectedIds.map((id, index) => ({ id, position: index + 1 })));
			if (mutation === 'move') expect(categoryPositions(2)).toContainEqual({ id: lastId, position: 7 });
		});
	}

	for (const userId of [1, 2]) {
		test(`reorder rejects a ban during authorization lookup for user ${userId}`, async () => {
			const { lastId } = await initCategory();
			const ctx = await createMockContext({ customToken: await getMockedToken(userId) });
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const caller = appRouter.createCaller({
				...ctx,
				needsPermission: async (permission) => {
					await ctx.needsPermission(permission);
					entered.resolve();
					await release.promise;
				},
			});
			const { handshakeHash } = await caller.others.handshake();
			await caller.others.joinServer({ handshakeHash });
			const request = caller.channels.reorder({ categoryId: 1, channelIds: [lastId, 1] });
			await entered.promise;
			tdb.update(users).set({ banned: true }).where(eq(users.id, userId)).run();
			const before = categoryPositions(1);
			release.resolve();
			await expect(request).rejects.toMatchObject({ code: 'FORBIDDEN' });
			expect(categoryPositions(1)).toEqual(before);
		});
	}

	for (const { roleAllow, userAllow } of [
		{ roleAllow: true, userAllow: undefined },
		{ roleAllow: true, userAllow: false },
		{ roleAllow: false, userAllow: true },
	]) {
		test(`reorder respects private visibility with role allow ${roleAllow} and user allow ${userAllow}`, async () => {
			const { moderatorCaller, privateId, lastId, memberRoleId } = await initCategory();
			tdb
				.insert(channelRolePermissions)
				.values({
					channelId: privateId,
					roleId: memberRoleId,
					permission: ChannelPermission.VIEW_CHANNEL,
					allow: roleAllow,
					createdAt: Date.now(),
				})
				.run();
			if (userAllow !== undefined) {
				tdb
					.insert(channelUserPermissions)
					.values({
						channelId: privateId,
						userId: 2,
						permission: ChannelPermission.VIEW_CHANNEL,
						allow: userAllow,
						createdAt: Date.now(),
					})
					.run();
			}
			await moderatorCaller.channels.reorder({ categoryId: 1, channelIds: [privateId, lastId, 1] });
			const visible = userAllow ?? roleAllow;
			expect(categoryPositions(1)).toEqual(
				(visible ? [privateId, lastId, 1] : [lastId, privateId, 1]).map((id, index) => ({ id, position: index + 1 })),
			);
		});
	}

	test('empty input normalizes ties deterministically and hidden channels at both ends keep ordinal slots without payload delivery', async () => {
		const { ownerCaller, moderatorCaller, privateId, lastId } = await initCategory();
		const endId = await ownerCaller.channels.add({ type: ChannelType.TEXT, name: 'Hidden end', categoryId: 1 });
		await ownerCaller.channels.update({ channelId: endId, private: true });
		for (const [id, position] of [
			[privateId, 0],
			[1, 2],
			[lastId, 2],
			[endId, 9],
		] as const)
			tdb.update(channels).set({ position }).where(eq(channels.id, id)).run();
		const received: number[] = [];
		const subscription = pubsub.subscribeFor(2, ServerEvents.CHANNEL_UPDATE).subscribe({
			next: (channel) => {
				received.push(channel.id);
			},
		});
		try {
			await moderatorCaller.channels.reorder({ categoryId: 1, channelIds: [] });
			expect(categoryPositions(1)).toEqual(
				[privateId, 1, lastId, endId].map((id, index) => ({ id, position: index + 1 })),
			);
			expect(received.sort((a, b) => a - b)).toEqual([1, lastId]);
			received.length = 0;
			await moderatorCaller.channels.reorder({ categoryId: 1, channelIds: [endId, lastId, lastId, privateId] });
			expect(categoryPositions(1)).toEqual(
				[privateId, lastId, 1, endId].map((id, index) => ({ id, position: index + 1 })),
			);
			expect(received.sort((a, b) => a - b)).toEqual([1, lastId]);
		} finally {
			subscription.unsubscribe();
		}
	});

	test('public permission management requires global permission despite channel grants', async () => {
		const { caller: owner } = await initTest(1);
		await owner.channels.updatePermissions({ channelId: 1, userId: 2, permissions: Object.values(ChannelPermission) });
		const { caller } = await initTest(2);
		for (const operation of ['get', 'update', 'delete'] as const) {
			const request =
				operation === 'get'
					? caller.channels.getPermissions({ channelId: 1 })
					: operation === 'update'
						? caller.channels.updatePermissions({ channelId: 1, userId: 2 })
						: caller.channels.deletePermissions({ channelId: 1, userId: 2 });
			await expect(request).rejects.toMatchObject({ code: 'FORBIDDEN' });
		}
	});

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
			const { moderatorCaller, memberRoleId } = await initModerator();
			const input = { channelId: 999, roleId: memberRoleId };
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
