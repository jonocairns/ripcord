import { ChannelPermission, Permission, ServerEvents } from '@sharkord/shared';
import { z } from 'zod';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';
import { publishVoiceSidebarEvent } from '../../utils/voice-sidebar-events';

const updateVoiceStateRoute = protectedProcedure
	.input(
		z.object({
			micMuted: z.boolean().optional(),
			soundMuted: z.boolean().optional(),
			webcamEnabled: z.boolean().optional(),
			sharingScreen: z.boolean().optional(),
			// Client-monotonic ordering token. Updates can reach the server out of
			// order (separate requests, awaited middleware), so without it two rapid
			// updates could apply in the wrong order.
			seq: z.number().int().nonnegative().optional(),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);
		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);
		const channelId = runtime.id;

		const { seq, ...stateInput } = input;
		const validatedInput = { ...stateInput };

		const can = ctx.createChannelPermissionChecker(channelId);
		const canSpeak = can(ChannelPermission.SPEAK);
		const canUseWebcam = can(ChannelPermission.WEBCAM);
		const canShareScreen = can(ChannelPermission.SHARE_SCREEN);

		if (!canSpeak && validatedInput.micMuted !== undefined) {
			logger.info({
				message: 'Voice mute update stripped by permission',
				callSite: 'updateState',
				userId: ctx.user.id,
				channelId,
				seq,
				clientInstanceId: ctx.getClientInstanceId(),
				requestedMicMuted: validatedInput.micMuted,
			});
			delete validatedInput.micMuted;
		}

		if (!canUseWebcam) {
			delete validatedInput.webcamEnabled;
		}

		if (!canShareScreen) {
			delete validatedInput.sharingScreen;
		}

		const applied = runtime.applyClientVoiceStateUpdate(ctx.user.id, validatedInput, seq, {
			clientInstanceId: ctx.getClientInstanceId(),
			requestedMicMuted: input.micMuted,
			requestedSoundMuted: input.soundMuted,
		});

		if (!applied) {
			return;
		}

		const newState = runtime.getUserState(ctx.user.id);

		publishVoiceSidebarEvent(ServerEvents.USER_VOICE_STATE_UPDATE, {
			channelId,
			userId: ctx.user.id,
			state: newState,
		});
	});

export { updateVoiceStateRoute };
