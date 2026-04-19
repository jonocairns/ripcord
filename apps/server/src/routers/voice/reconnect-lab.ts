import { ServerEvents } from '@sharkord/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { config } from '../../config';
import { VoiceRuntime } from '../../runtimes/voice';
import { IS_TEST } from '../../utils/env';
import { protectedProcedure, t } from '../../utils/trpc';
import {
  clearVoiceReconnectLabNextRestoreBehavior,
  setVoiceReconnectLabNextRestoreBehavior
} from './reconnect-lab-state';

const restoreBehaviorFailCodeSchema = z.enum([
  'INTERNAL_SERVER_ERROR',
  'UNAUTHORIZED',
  'CONFLICT'
]);

const nextRestoreBehaviorInputSchema = z
  .object({
    delayMs: z.number().int().min(1).max(30_000).optional(),
    failCode: restoreBehaviorFailCodeSchema.optional(),
    failMessage: z.string().trim().min(1).max(120).optional(),
    closeWsCode: z.number().int().min(1_000).max(49_999).optional(),
    closeWsReason: z.string().trim().min(1).max(120).optional()
  })
  .refine(
    (input) =>
      input.delayMs !== undefined ||
      input.failCode !== undefined ||
      input.failMessage !== undefined ||
      input.closeWsCode !== undefined,
    {
      message: 'At least one reconnect-lab restore behavior is required.'
    }
  )
  .refine(
    (input) =>
      input.closeWsReason === undefined || input.closeWsCode !== undefined,
    {
      message: 'closeWsReason requires closeWsCode.'
    }
  );

const assertReconnectLabEnabled = () => {
  if (!config.server.debug && !IS_TEST) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Voice reconnect lab is disabled.'
    });
  }
};

const voiceReconnectLabRouter = t.router({
  setNextRestoreBehavior: protectedProcedure
    .input(nextRestoreBehaviorInputSchema)
    .mutation(({ input, ctx }) => {
      assertReconnectLabEnabled();

      setVoiceReconnectLabNextRestoreBehavior(ctx.user.id, input);

      return input;
    }),
  clearNextRestoreBehavior: protectedProcedure.mutation(({ ctx }) => {
    assertReconnectLabEnabled();

    clearVoiceReconnectLabNextRestoreBehavior(ctx.user.id);

    return {
      cleared: true
    };
  }),
  emitTransportFailed: protectedProcedure.mutation(({ ctx }) => {
    assertReconnectLabEnabled();

    const runtime = VoiceRuntime.findRuntimeByUserId(ctx.user.id);

    if (!runtime) {
      return {
        emitted: false,
        reason: 'not-in-voice'
      };
    }

    ctx.pubsub.publishFor(ctx.user.id, ServerEvents.VOICE_TRANSPORT_FAILED, {
      userId: ctx.user.id
    });

    return {
      emitted: true
    };
  }),
  forgetOwnVoiceSession: protectedProcedure.mutation(({ ctx }) => {
    assertReconnectLabEnabled();

    const runtime = VoiceRuntime.findRuntimeByUserId(ctx.user.id);

    if (!runtime) {
      return {
        forgotten: false
      };
    }

    runtime.removeUser(ctx.user.id);
    ctx.pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
      channelId: runtime.id,
      userId: ctx.user.id,
      reconnecting: true
    });
    ctx.currentVoiceChannelId = undefined;
    ctx.setWsVoiceChannelId(undefined);

    return {
      forgotten: true,
      channelId: runtime.id
    };
  })
});

export { voiceReconnectLabRouter };
