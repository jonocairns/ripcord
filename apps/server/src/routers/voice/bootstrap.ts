import { ChannelPermission, ChannelType, Permission } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import type { Context } from '../../utils/trpc';
import type { TVoiceTransportPairObserver } from '../../voice-session-observability';

const voiceJoinStateSchema = z.object({
	micMuted: z.boolean().default(false),
	soundMuted: z.boolean().default(false),
});

const voiceJoinInputSchema = z.object({
	channelId: z.number(),
	state: voiceJoinStateSchema,
	mutationSeq: z.number().int().nonnegative().optional(),
});

const getVoiceJoinTarget = async (ctx: Context, channelId: number) => {
	await Promise.all([
		ctx.needsPermission(Permission.JOIN_VOICE_CHANNELS),
		ctx.needsChannelPermission(channelId, ChannelPermission.JOIN),
	]);

	const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();

	invariant(channel, {
		code: 'NOT_FOUND',
		message: 'Channel not found',
	});

	invariant(channel.type === ChannelType.VOICE, {
		code: 'BAD_REQUEST',
		message: 'Channel is not a voice channel',
	});

	const runtime = VoiceRuntime.findById(channelId);

	invariant(runtime, {
		code: 'INTERNAL_SERVER_ERROR',
		message: 'Voice runtime not found for this channel',
	});

	return { channel, runtime };
};

const prepareVoiceJoinBootstrap = async (opts: {
	runtime: VoiceRuntime;
	userId: number;
	pairObserver?: TVoiceTransportPairObserver;
}) => {
	const { runtime, userId, pairObserver } = opts;
	const router = runtime.getRouter();
	const pair = await runtime.prepareTransportPair(userId, pairObserver);

	return {
		assertCommittable: pair.assertCommittable,
		commit: pair.commit,
		dispose: pair.dispose,
		buildCommittedResponse: () => ({
			routerRtpCapabilities: router.rtpCapabilities,
			producerTransportParams: pair.producerParams,
			consumerTransportParams: pair.consumerParams,
			existingProducers: runtime.getRemoteIds(userId),
			channelUsers: runtime.getState().users,
		}),
	};
};

export { getVoiceJoinTarget, prepareVoiceJoinBootstrap, voiceJoinInputSchema };
