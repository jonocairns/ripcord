import { ChannelPermission, Permission, ServerEvents } from '@sharkord/shared';
import { loadChannelGrants, loadUserGrants } from '../db/queries/permissions';
import { VoiceRuntime } from '../runtimes/voice';
import { hasChannelAccess, hasGlobalPermission } from './permission-policy';
import { publishVoiceSidebarEvent } from './voice-sidebar-events';

// Mirrors the permission checks performed by `joinVoiceRoute`:
// `Permission.JOIN_VOICE_CHANNELS` + `ChannelPermission.JOIN`. SPEAK, WEBCAM,
// and SHARE_SCREEN are enforced granularly at produce/update-state time, so a
// user with JOIN but without SPEAK is a legitimate listen-only participant and
// must not be evicted by the revalidation loop.
const canUserRemainInVoiceChannel = async (userId: number, channelId: number): Promise<boolean> => {
	const user = loadUserGrants(userId);
	return (
		hasGlobalPermission(user, Permission.JOIN_VOICE_CHANNELS) &&
		hasChannelAccess(user, loadChannelGrants(userId, channelId), ChannelPermission.JOIN)
	);
};

const revalidateActiveVoiceSessions = async (options?: {
	userIds?: number[];
	channelIds?: number[];
}): Promise<void> => {
	const userIdSet = options?.userIds && options.userIds.length > 0 ? new Set(options.userIds) : undefined;
	const channelIdSet = options?.channelIds && options.channelIds.length > 0 ? new Set(options.channelIds) : undefined;

	for (const runtime of VoiceRuntime.getAll()) {
		if (channelIdSet && !channelIdSet.has(runtime.id)) {
			continue;
		}

		// Snapshot every seat identity before permission awaits can yield to a rejoin.
		const activeUsers = runtime.getState().users.map((user) => ({
			userId: user.userId,
			sessionIncarnation: runtime.getVoiceSessionIncarnation(user.userId),
		}));

		for (const activeUser of activeUsers) {
			if (userIdSet && !userIdSet.has(activeUser.userId)) {
				continue;
			}

			const canRemain = await canUserRemainInVoiceChannel(activeUser.userId, runtime.id);

			if (canRemain) {
				continue;
			}

			if (!runtime.removeUserIfSessionMatches(activeUser.userId, activeUser.sessionIncarnation)) {
				continue;
			}

			publishVoiceSidebarEvent(ServerEvents.USER_LEAVE_VOICE, {
				channelId: runtime.id,
				userId: activeUser.userId,
			});
		}
	}
};

export { revalidateActiveVoiceSessions };
