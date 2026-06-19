import { ChannelPermission, Permission } from '@sharkord/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

// Newer clients run speaking detection locally and report transitions here for
// instant feedback; the runtime relays them to the channel. The server's audio
// observer remains the fallback for clients that never call this. The sequence
// number lets the runtime drop reordered fire-and-forget reports.
const updateVoiceActivityRoute = protectedProcedure
	.input(
		z.object({
			isSpeaking: z.boolean(),
			seq: z.number().int().nonnegative(),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);
		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);

		// A user without SPEAK permission can never light up the speaking ring,
		// regardless of what their client reports.
		const canSpeak = await ctx.hasChannelPermission(runtime.id, ChannelPermission.SPEAK);

		runtime.applyClientVoiceActivity(ctx.user.id, input.isSpeaking && canSpeak, input.seq);
	});

export { updateVoiceActivityRoute };
