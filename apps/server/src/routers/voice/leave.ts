import { ChannelType, Permission, ServerEvents } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const leaveVoiceRoute = protectedProcedure.mutation(async ({ ctx }) => {
	// Capture the session identity this leave was issued against before any
	// await. The handler interleaves with concurrent join/restore handlers, so
	// reading these later could observe a replacement session instead.
	const channelId = ctx.currentVoiceChannelId;
	const sessionIncarnation = ctx.currentVoiceSessionIncarnation;

	await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

	invariant(channelId, {
		code: 'BAD_REQUEST',
		message: 'User is not in a voice channel',
	});

	const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();

	invariant(channel, {
		code: 'NOT_FOUND',
		message: 'Channel not found',
	});

	invariant(channel.type === ChannelType.VOICE, {
		code: 'BAD_REQUEST',
		message: 'Channel is not a voice channel',
	});

	const runtime = VoiceRuntime.findById(channelId);

	invariant(runtime, {
		code: 'INTERNAL_SERVER_ERROR',
		message: 'Voice runtime not found for this channel',
	});

	// Clear this connection's bookkeeping only while it still describes the
	// captured session — an interleaved join on this connection may have
	// installed a newer one that must stay bound.
	const clearOwnSessionBookkeeping = () => {
		if (ctx.currentVoiceSessionIncarnation === sessionIncarnation) {
			ctx.currentVoiceChannelId = undefined;
			ctx.currentVoiceSessionIncarnation = undefined;
			ctx.setWsVoiceChannelId(undefined);
		}
	};

	const userInChannel = runtime.getUser(ctx.user.id);
	const seatSuperseded =
		sessionIncarnation !== undefined && runtime.getVoiceSessionIncarnation(ctx.user.id) !== sessionIncarnation;

	// The seat is already gone, or it belongs to a newer session (a join or
	// restore replaced it while this leave was in flight). Removing it would
	// kill the replacement, so treat the leave as already satisfied.
	if (!userInChannel || seatSuperseded) {
		clearOwnSessionBookkeeping();

		logger.info(
			'%s voice leave for channel %s was a no-op (%s)',
			ctx.user.name,
			channel.name,
			userInChannel ? 'seat superseded by a newer session' : 'seat already removed',
		);
		return;
	}

	runtime.removeUser(ctx.user.id);

	ctx.pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
		channelId,
		userId: ctx.user.id,
	});
	clearOwnSessionBookkeeping();

	logger.info('%s left voice channel %s', ctx.user.name, channel.name);
});

export { leaveVoiceRoute };
