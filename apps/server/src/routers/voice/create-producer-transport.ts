import { Permission } from '@sharkord/shared';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

const createProducerTransportRoute = protectedProcedure.mutation(async ({ ctx }) => {
	await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

	const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);
	const sessionIncarnation = ctx.currentVoiceSessionIncarnation;
	const activeTransport = runtime.getProducerTransport(ctx.user.id);

	const params = await runtime.createProducerTransport(
		ctx.user.id,
		() =>
			ctx.currentVoiceChannelId === runtime.id &&
			ctx.currentVoiceSessionIncarnation === sessionIncarnation &&
			runtime.getVoiceSessionIncarnation(ctx.user.id) === sessionIncarnation &&
			runtime.getProducerTransport(ctx.user.id) === activeTransport,
	);

	return params;
});

export { createProducerTransportRoute };
