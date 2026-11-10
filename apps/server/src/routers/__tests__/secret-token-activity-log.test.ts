import { describe, expect, test } from 'bun:test';
import { OWNER_ROLE_ID, sha256 } from '@sharkord/shared';
import { and, eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { TEST_SECRET_TOKEN } from '../../__tests__/seed';
import { tdb } from '../../__tests__/setup';
import { activityLog, userRoles } from '../../db/schema';

describe('secret token activity log', () => {
	test('records exactly one owner grant with the user and no token material', async () => {
		const { caller } = await initTest(2);
		await tdb.delete(activityLog);
		const { useSecretToken: submitSecretToken } = caller.others;

		await submitSecretToken({ token: TEST_SECRET_TOKEN });

		const grants = await tdb
			.select()
			.from(userRoles)
			.where(and(eq(userRoles.userId, 2), eq(userRoles.roleId, OWNER_ROLE_ID)));
		expect(grants).toHaveLength(1);

		const entries = await tdb.select().from(activityLog);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: 'USER_USED_SECRET_TOKEN',
			userId: 2,
			details: {},
		});
		const serialized = JSON.stringify(entries);
		expect(serialized).not.toContain(TEST_SECRET_TOKEN);
		expect(serialized).not.toContain(await sha256(TEST_SECRET_TOKEN));
	});

	test('does not record a grant when the owner role insert fails', async () => {
		const { caller } = await initTest(1);
		await tdb.delete(activityLog);

		await expect(caller.others.useSecretToken({ token: TEST_SECRET_TOKEN })).rejects.toThrow();

		expect(await tdb.select().from(activityLog)).toEqual([]);
	});

	test('keeps invalid and rate-limited attempts out of the activity log', async () => {
		const { caller } = await initTest(2);
		await tdb.delete(activityLog);
		const { useSecretToken: submitSecretToken } = caller.others;

		for (let attempt = 0; attempt < 5; attempt += 1) {
			await expect(submitSecretToken({ token: 'invalid-token' })).rejects.toThrow('Invalid secret token');
		}
		await expect(submitSecretToken({ token: TEST_SECRET_TOKEN })).rejects.toThrow(
			'Too many requests. Please try again shortly.',
		);

		expect(await tdb.select().from(activityLog)).toEqual([]);
		const grants = await tdb
			.select()
			.from(userRoles)
			.where(and(eq(userRoles.userId, 2), eq(userRoles.roleId, OWNER_ROLE_ID)));
		expect(grants).toEqual([]);
	});
});
