import { expect, test } from 'bun:test';
import { ChannelPermission as C } from '@sharkord/shared';
import { canViewChannel, hasChannelAccess, type TChannelGrants, type TUserGrants } from '../permission-policy';

const member: TUserGrants = { banned: false, isOwner: false, permissions: new Set() };
const owner: TUserGrants = { ...member, isOwner: true };
const grant = (permission: C, allow: boolean) => ({ permission, allow });

test('request check order: missing, public, valid user, owner, view and requested grant', () => {
	const privateChannel: TChannelGrants = { private: true, user: [], roles: [] };
	for (const user of [undefined, member, { ...member, banned: true }, owner, { ...owner, banned: true }]) {
		for (const permission of Object.values(C)) {
			expect(hasChannelAccess(user, undefined, permission)).toBe(false);
			expect(hasChannelAccess(user, { ...privateChannel, private: false }, permission)).toBe(true);
			expect(
				hasChannelAccess(
					user,
					{ private: false, user: [grant(C.VIEW_CHANNEL, false), grant(permission, false)], roles: [] },
					permission,
				),
			).toBe(true);
		}
	}
	expect(hasChannelAccess(undefined, privateChannel, C.JOIN)).toBe(false);
	const allows = { ...privateChannel, user: [grant(C.VIEW_CHANNEL, true), grant(C.JOIN, true)] };
	expect(hasChannelAccess({ ...member, banned: true }, allows, C.JOIN)).toBe(false);
	expect(hasChannelAccess({ ...owner, banned: true }, allows, C.JOIN)).toBe(false);
	const denies = { ...privateChannel, user: [grant(C.VIEW_CHANNEL, false), grant(C.JOIN, false)] };
	for (const permission of [C.JOIN, C.VIEW_CHANNEL]) expect(hasChannelAccess(owner, denies, permission)).toBe(true);
	for (const [user, roles, expected] of [
		[[grant(C.VIEW_CHANNEL, true), grant(C.JOIN, true)], [], true],
		[[grant(C.VIEW_CHANNEL, true)], [], false],
		[[grant(C.VIEW_CHANNEL, true), grant(C.JOIN, false)], [], false],
		[[grant(C.JOIN, true)], [], false],
		[[grant(C.VIEW_CHANNEL, false), grant(C.JOIN, true)], [grant(C.VIEW_CHANNEL, true)], false],
	] satisfies [TChannelGrants['user'], TChannelGrants['roles'], boolean][]) {
		expect(hasChannelAccess(member, { private: true, user, roles }, C.JOIN)).toBe(expected);
	}
	expect(hasChannelAccess(member, { ...privateChannel, user: [grant(C.VIEW_CHANNEL, true)] }, C.VIEW_CHANNEL)).toBe(
		true,
	);
});

test('listing visibility agrees with request view for every valid user/grant combination', () => {
	const view = (allow: boolean) => grant(C.VIEW_CHANNEL, allow);
	const combinations: Pick<TChannelGrants, 'user' | 'roles'>[] = [
		{ user: [], roles: [] },
		{ user: [view(true)], roles: [] },
		{ user: [view(false)], roles: [] },
		{ user: [], roles: [view(true)] },
		{ user: [], roles: [view(false)] },
		{ user: [view(false)], roles: [view(true)] },
		{ user: [view(true)], roles: [view(false)] },
	];
	for (const isOwner of [false, true])
		for (const isPrivate of [false, true])
			for (const rows of combinations) {
				const channel = { private: isPrivate, ...rows };
				expect(canViewChannel(isOwner, channel)).toBe(
					hasChannelAccess({ ...member, isOwner }, channel, C.VIEW_CHANNEL),
				);
			}
});
