import { ChannelPermission, Permission, ServerEvents } from '@sharkord/shared';
import { z } from 'zod';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure } from '../../utils/trpc';

const updateVoiceStateRoute = protectedProcedure
  .input(
    z.object({
      micMuted: z.boolean().optional(),
      soundMuted: z.boolean().optional(),
      webcamEnabled: z.boolean().optional(),
      sharingScreen: z.boolean().optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS);
    const runtime = VoiceRuntime.requireJoinedRuntime(
      ctx.currentVoiceChannelId,
      ctx.user.id
    );
    const channelId = runtime.id;

    const validatedInput = { ...input };

    const [canSpeak, canUseWebcam, canShareScreen] = await Promise.all([
      ctx.hasChannelPermission(channelId, ChannelPermission.SPEAK),
      ctx.hasChannelPermission(channelId, ChannelPermission.WEBCAM),
      ctx.hasChannelPermission(channelId, ChannelPermission.SHARE_SCREEN)
    ]);

    if (!canSpeak) {
      delete validatedInput.micMuted;
    }

    if (!canUseWebcam) {
      delete validatedInput.webcamEnabled;
    }

    if (!canShareScreen) {
      delete validatedInput.sharingScreen;
    }

    runtime.updateUserState(ctx.user.id, {
      ...validatedInput
    });

    const newState = runtime.getUserState(ctx.user.id);

    ctx.pubsub.publish(ServerEvents.USER_VOICE_STATE_UPDATE, {
      channelId,
      userId: ctx.user.id,
      state: newState
    });
  });

export { updateVoiceStateRoute };
