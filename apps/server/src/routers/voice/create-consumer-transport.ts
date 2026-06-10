import { Permission } from '@sharkord/shared';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

const createConsumerTransportRoute = protectedProcedure.mutation(async ({ ctx }) => {
	await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

	const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

	const params = await runtime.createConsumerTransport(ctx.user.id);

	return params;
});

export { createConsumerTransportRoute };
