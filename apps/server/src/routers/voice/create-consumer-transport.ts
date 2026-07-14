import { Permission } from '@sharkord/shared';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

const createConsumerTransportRoute = protectedProcedure.mutation(async ({ ctx }) => {
	await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

	const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);
	const sessionIncarnation = ctx.currentVoiceSessionIncarnation;
	const activeTransport = runtime.getConsumerTransport(ctx.user.id);

	const params = await runtime.createConsumerTransport(
		ctx.user.id,
		() =>
			ctx.currentVoiceChannelId === runtime.id &&
			ctx.currentVoiceSessionIncarnation === sessionIncarnation &&
			runtime.getVoiceSessionIncarnation(ctx.user.id) === sessionIncarnation &&
			runtime.getConsumerTransport(ctx.user.id) === activeTransport,
	);

	return params;
});

export { createConsumerTransportRoute };
