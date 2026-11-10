import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import { ChannelPermission as C } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import {
	getAllChannelUserPermissions,
	getChannelOverrideSubjectIds,
	getChannelsForUser,
	getChannelViewerIds,
	getChannelViewerIdsSync,
	getVisiblePrivateChannelIdsByUserSync,
} from '../../db/queries/channels';
import { channelRolePermissions, channels, channelUserPermissions, roles, userRoles, users } from '../../db/schema';

const userGrant = (subject: number, permission: string, allow: boolean) =>
	tdb.insert(channelUserPermissions).values({ channelId: 2, userId: subject, permission, allow, createdAt: 0 }).run();
const roleGrant = (permission: string, allow: boolean, roleId?: number) => {
	const role = tdb.select().from(userRoles).where(eq(userRoles.userId, 2)).get();
	if (!role) throw new Error('Missing member role');
	tdb
		.insert(channelRolePermissions)
		.values({ channelId: 2, roleId: roleId ?? role.roleId, permission, allow, createdAt: 0 })
		.run();
};
const ban = (subject: number) => tdb.update(users).set({ banned: true }).where(eq(users.id, subject)).run();
const privateChannel = () => tdb.update(channels).set({ private: true }).where(eq(channels.id, 2)).run();
const raw = (keys: C[]) => ({
	[C.VIEW_CHANNEL]: keys.includes(C.VIEW_CHANNEL),
	[C.JOIN]: keys.includes(C.JOIN),
	[C.SEND_MESSAGES]: keys.includes(C.SEND_MESSAGES),
	[C.SPEAK]: keys.includes(C.SPEAK),
	[C.SHARE_SCREEN]: keys.includes(C.SHARE_SCREEN),
	[C.WEBCAM]: keys.includes(C.WEBCAM),
});
type Row = {
	name: string;
	subject: number;
	setup: () => void;
	views: boolean;
	context: boolean;
	keys: C[];
	override: boolean;
	denied?: C;
};
const rows: Row[] = [
	{ name: '1 no rows', subject: 2, setup: () => {}, views: false, context: false, keys: [], override: false },
	{
		name: '2 role view allow',
		subject: 2,
		setup: () => {
			roleGrant(C.VIEW_CHANNEL, true);
		},
		views: true,
		context: true,
		keys: [C.VIEW_CHANNEL],
		override: true,
	},
	{
		name: '3 role view deny',
		subject: 2,
		setup: () => {
			roleGrant(C.VIEW_CHANNEL, false);
		},
		views: false,
		context: false,
		keys: [],
		override: true,
	},
	...[false, true].map(
		(reverse): Row => ({
			name: `4 conflicting roles reverse=${reverse}`,
			subject: 2,
			setup: () => {
				tdb.delete(userRoles).where(eq(userRoles.userId, 2)).run();
				for (const id of [10, 11]) {
					tdb
						.insert(roles)
						.values({ id, name: `Role ${id}`, color: '#ffffff', isPersistent: false, isDefault: false, createdAt: 0 })
						.run();
					tdb.insert(userRoles).values({ userId: 2, roleId: id, createdAt: 0 }).run();
				}
				for (const id of reverse ? [11, 10] : [10, 11]) roleGrant(C.VIEW_CHANNEL, id === 10, id);
			},
			views: true,
			context: true,
			keys: [C.VIEW_CHANNEL],
			override: true,
		}),
	),
	{
		name: '5 user without roles',
		subject: 2,
		setup: () => {
			userGrant(2, C.VIEW_CHANNEL, true);
			tdb.delete(userRoles).where(eq(userRoles.userId, 2)).run();
		},
		views: true,
		context: true,
		keys: [C.VIEW_CHANNEL],
		override: true,
	},
	{
		name: '6 user deny beats role',
		subject: 2,
		setup: () => {
			userGrant(2, C.VIEW_CHANNEL, false);
			roleGrant(C.VIEW_CHANNEL, true);
		},
		views: false,
		context: false,
		keys: [],
		override: true,
	},
	{
		name: '7 owner denies',
		subject: 1,
		setup: () => {
			userGrant(1, C.VIEW_CHANNEL, false);
			userGrant(1, C.JOIN, false);
		},
		views: true,
		context: true,
		keys: Object.values(C),
		override: true,
	},
	{
		name: '8 banned member',
		subject: 2,
		setup: () => {
			roleGrant(C.VIEW_CHANNEL, true);
			ban(2);
		},
		views: true,
		context: false,
		keys: [C.VIEW_CHANNEL],
		override: true,
	},
	{
		name: '9 banned owner',
		subject: 1,
		setup: () => {
			ban(1);
		},
		views: true,
		context: false,
		keys: Object.values(C),
		override: true,
	},
	{
		name: '10 join without view',
		subject: 2,
		setup: () => {
			userGrant(2, C.JOIN, true);
		},
		views: false,
		context: false,
		keys: [C.JOIN],
		override: true,
		denied: C.JOIN,
	},
	{
		name: '11 send deny beats role',
		subject: 2,
		setup: () => {
			userGrant(2, C.VIEW_CHANNEL, true);
			userGrant(2, C.SEND_MESSAGES, false);
			roleGrant(C.SEND_MESSAGES, true);
		},
		views: true,
		context: true,
		keys: [C.VIEW_CHANNEL],
		override: true,
		denied: C.SEND_MESSAGES,
	},
	{
		name: '12 unknown stored strings',
		subject: 2,
		setup: () => {
			userGrant(2, 'LEGACY_PERMISSION', true);
			roleGrant('LEGACY_PERMISSION', true);
		},
		views: false,
		context: false,
		keys: [],
		override: true,
	},
];

const check = async (row: Row) => {
	const ctx = await createMockContext({ customToken: await getMockedToken(row.subject) });
	privateChannel();
	row.setup();
	expect((await getChannelsForUser(row.subject)).some((c) => c.id === 2)).toBe(row.views);
	const viewers = getChannelViewerIdsSync(2);
	expect(viewers?.includes(row.subject)).toBe(row.views);
	expect(new Set(await getChannelViewerIds(2))).toEqual(new Set(viewers));
	expect(getVisiblePrivateChannelIdsByUserSync([row.subject]).get(row.subject)?.has(2)).toBe(row.views);
	expect(await ctx.hasChannelPermission(2, C.VIEW_CHANNEL)).toBe(row.context);
	if (row.denied) expect(await ctx.hasChannelPermission(2, row.denied)).toBe(false);
	expect((await getAllChannelUserPermissions(row.subject))[2]?.permissions).toEqual(raw(row.keys));
	const subjects = await getChannelOverrideSubjectIds(2);
	expect(subjects.includes(row.subject)).toBe(row.override);
	expect(subjects).toContain(1);
};
for (const row of rows) test(`private parity ${row.name}, subject ${row.subject}`, () => check(row));

for (const fixture of [
	{ name: 'P1 member', subject: 2, setup: () => {} },
	{
		name: 'P2 denied member',
		subject: 2,
		setup: () => {
			userGrant(2, C.VIEW_CHANNEL, false);
			userGrant(2, C.JOIN, false);
		},
	},
	{
		name: 'P3 banned member',
		subject: 2,
		setup: () => {
			ban(2);
		},
	},
	{ name: 'P4 owner', subject: 1, setup: () => {} },
])
	test(`public parity ${fixture.name}, subject ${fixture.subject}`, async () => {
		const ctx = await createMockContext({ customToken: await getMockedToken(fixture.subject) });
		fixture.setup();
		const ids = tdb
			.select({ id: users.id })
			.from(users)
			.all()
			.map((u) => u.id);
		expect(new Set(getChannelViewerIdsSync(2))).toEqual(new Set(ids));
		expect(new Set(await getChannelOverrideSubjectIds(2))).toEqual(new Set(ids));
		expect((await getChannelsForUser(fixture.subject)).some((c) => c.id === 2)).toBe(true);
		for (const permission of [C.VIEW_CHANNEL, C.JOIN]) expect(await ctx.hasChannelPermission(2, permission)).toBe(true);
		expect((await getAllChannelUserPermissions(fixture.subject))[2]?.permissions).toEqual(
			raw(fixture.subject === 1 ? Object.values(C) : []),
		);
	});

test('missing channel and empty snapshot', async () => {
	expect(getChannelViewerIdsSync(999)).toBeUndefined();
	expect(await getChannelOverrideSubjectIds(999)).toEqual([]);
	expect(getVisiblePrivateChannelIdsByUserSync([])).toEqual(new Map());
});

test('snapshot excludes public channel ids', () => {
	expect(getVisiblePrivateChannelIdsByUserSync([1, 2]).get(2)?.has(1)).toBe(false);
});

const statementCount = (operation: () => unknown) => {
	const prepare = spyOn(Database.prototype, 'prepare');
	try {
		operation();
		return prepare.mock.calls.length;
	} finally {
		prepare.mockRestore();
	}
};

test('snapshot statement count is independent of private channel count', () => {
	privateChannel();
	const one = statementCount(() => getVisiblePrivateChannelIdsByUserSync([1, 2]));
	for (const id of [10, 11, 12, 13])
		tdb
			.insert(channels)
			.values({
				id,
				name: `Private ${id}`,
				type: 'voice',
				private: true,
				position: id,
				createdAt: 0,
				fileAccessToken: String(id),
				fileAccessTokenUpdatedAt: 0,
			})
			.run();
	const five = statementCount(() => getVisiblePrivateChannelIdsByUserSync([1, 2]));
	expect(five).toBe(one);
});

test('public viewer lookup prepares at most two statements', () => {
	expect(statementCount(() => getChannelViewerIdsSync(2))).toBeLessThanOrEqual(2);
});
for (const roleAllow of [false, true])
	test(`private viewer lookup uses at most four statements, role allow=${roleAllow}`, () => {
		privateChannel();
		if (roleAllow) roleGrant(C.VIEW_CHANNEL, true);
		// Base prepares four statements without a role row, five with a role allow.
		expect(statementCount(() => getChannelViewerIdsSync(2))).toBeLessThanOrEqual(4);
	});
test('empty private snapshot prepares no statements', () => {
	expect(statementCount(() => getVisiblePrivateChannelIdsByUserSync([]))).toBe(0);
});
