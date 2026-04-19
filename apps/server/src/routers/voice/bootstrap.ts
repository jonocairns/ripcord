import { ChannelPermission, ChannelType, Permission } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import type { Context } from '../../utils/trpc';

const voiceJoinStateSchema = z.object({
  micMuted: z.boolean().default(false),
  soundMuted: z.boolean().default(false)
});

const voiceJoinInputSchema = z.object({
  channelId: z.number(),
  state: voiceJoinStateSchema
});

const getVoiceJoinTarget = async (ctx: Context, channelId: number) => {
  await Promise.all([
    ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS),
    ctx.needsChannelPermission(channelId, ChannelPermission.JOIN)
  ]);

  const channel = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .get();

  invariant(channel, {
    code: 'NOT_FOUND',
    message: 'Channel not found'
  });

  invariant(channel.type === ChannelType.VOICE, {
    code: 'BAD_REQUEST',
    message: 'Channel is not a voice channel'
  });

  const runtime = VoiceRuntime.findById(channelId);

  invariant(runtime, {
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Voice runtime not found for this channel'
  });

  return { channel, runtime };
};

const createVoiceJoinBootstrap = async (opts: {
  runtime: VoiceRuntime;
  userId: number;
  onError?: (error: unknown) => void | Promise<void>;
}) => {
  const { runtime, userId, onError } = opts;
  const router = runtime.getRouter();

  let producerTransportParams;
  let consumerTransportParams;
  let existingProducers;

  try {
    [producerTransportParams, consumerTransportParams] = await Promise.all([
      runtime.createProducerTransport(userId),
      runtime.createConsumerTransport(userId)
    ]);

    existingProducers = runtime.getRemoteIds(userId);
  } catch (error) {
    await onError?.(error);
    throw error;
  }

  return {
    routerRtpCapabilities: router.rtpCapabilities,
    producerTransportParams,
    consumerTransportParams,
    existingProducers,
    channelUsers: runtime.getState().users
  };
};

export { createVoiceJoinBootstrap, getVoiceJoinTarget, voiceJoinInputSchema };
