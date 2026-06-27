import { ChannelPermission, Permission } from '@sharkord/shared';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

// Allocates the PlainTransport ingest for native desktop app/system audio.
//
// This route is the authorization boundary for app/system audio: SHARE_SCREEN is
// required and a denial is hard (FORBIDDEN) — it must never degrade to a fallback,
// because the worklet fallback path produces SCREEN_AUDIO too and would otherwise
// escape the gate (the legacy produce.ts path is backfilled with the same gate).
const createAppAudioIngestRoute = protectedProcedure.mutation(async ({ ctx }) => {
	await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

	const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

	await ctx.needsChannelPermission(runtime.id, ChannelPermission.SHARE_SCREEN);

	return runtime.createAppAudioIngest(ctx.user.id);
});

export { createAppAudioIngestRoute };
