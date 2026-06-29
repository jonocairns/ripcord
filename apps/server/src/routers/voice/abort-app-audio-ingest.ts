import { Permission } from '@sharkord/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

// Releases a not-yet-published app audio ingest (PlainTransport/UDP port). The
// native desktop ingest attempt calls this when it fails after
// createAppAudioIngest but before produceAppAudio publishes; otherwise the
// transport would leak until leave or the next native attempt. Scoped by
// transport id so it is a no-op once a newer ingest has replaced it.
//
// Unlike createAppAudioIngest/produceAppAudio this is not an authorization
// boundary — it only releases the caller's own pending ingest — so it mirrors
// closeProducer and requires JOIN_VOICE_CHANNELS rather than SHARE_SCREEN.
const abortAppAudioIngestRoute = protectedProcedure
	.input(
		z.object({
			transportId: z.string(),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);

		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

		runtime.abortAppAudioIngest(ctx.user.id, input.transportId);
	});

export { abortAppAudioIngestRoute };
