import { ChannelPermission, Permission } from '@sharkord/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { srtpParametersSchema } from './schemas';

// Connects the client's SRTP keys to the previously-created PlainTransport ingest
// and publishes the SCREEN_AUDIO producer once first media is observed.
//
// Authorization mirrors createAppAudioIngest: SHARE_SCREEN is a hard requirement
// (FORBIDDEN), never a fallback. Operational outcomes — no first media within the
// timeout — resolve to { fallback: true }, and the runtime tears the ingest down
// before returning so no UDP port is leaked.
const produceAppAudioRoute = protectedProcedure
	.input(
		z.object({
			transportId: z.string(),
			srtpParameters: srtpParametersSchema,
		}),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

		await ctx.needsChannelPermission(runtime.id, ChannelPermission.SHARE_SCREEN);

		const ingest = runtime.getAppAudioIngest(ctx.user.id);

		invariant(ingest, {
			code: 'NOT_FOUND',
			message: 'App audio ingest not found',
		});

		// Reject a produce targeting a stale transport id (e.g. a request issued
		// against an ingest that was replaced during a reconnect race).
		invariant(ingest.transport.id === input.transportId, {
			code: 'BAD_REQUEST',
			message: 'App audio ingest transport id mismatch',
		});

		return runtime.produceAppAudio(ctx.user.id, {
			srtpParameters: input.srtpParameters,
		});
	});

export { produceAppAudioRoute };
