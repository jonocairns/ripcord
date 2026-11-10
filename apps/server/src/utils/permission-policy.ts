import { ChannelPermission, type Permission } from '@sharkord/shared';

export type TUserGrants = {
	banned: boolean;
	isOwner: boolean;
	permissions: ReadonlySet<Permission>;
};

type TChannelGrant = { permission: string; allow: boolean };
export type TChannelGrants = {
	private: boolean;
	user: readonly TChannelGrant[];
	roles: readonly TChannelGrant[];
};

export const hasGlobalPermission = (user: TUserGrants | undefined, target: Permission | Permission[]): boolean => {
	if (!user || user.banned) return false;
	if (user.isOwner) return true;
	return Array.isArray(target)
		? target.every((permission) => user.permissions.has(permission))
		: user.permissions.has(target);
};

export const resolveChannelGrant = (grants: TChannelGrants, permission: ChannelPermission): boolean => {
	const userRow = grants.user.find((row) => row.permission === permission);
	if (userRow) return userRow.allow;
	return grants.roles.some((row) => row.permission === permission && row.allow);
};

export const hasChannelAccess = (
	user: TUserGrants | undefined,
	channel: TChannelGrants | undefined,
	permission: ChannelPermission,
): boolean => {
	if (!channel) return false;
	if (!channel.private) return true;
	if (!user || user.banned) return false;
	if (user.isOwner) return true;
	return resolveChannelGrant(channel, ChannelPermission.VIEW_CHANNEL) && resolveChannelGrant(channel, permission);
};
