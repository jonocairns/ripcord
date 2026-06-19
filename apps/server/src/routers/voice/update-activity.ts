import { ChannelPermission, Permission } from '@sharkord/shared';
import { z } from 'zod';
import { config } from '../../config';
import { VoiceRuntime } from '../../runtimes/voice';
import { protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';

// Speaking transitions are high-frequency, so the SPEAK permission lookup is
// cached per (user, channel) for a short window rather than hitting the
// permission system on every report. A revoked permission stops showing the
// ring within at most this TTL — acceptable for a cosmetic indicator, and the
// revalidation path still removes the user from voice for real enforcement.
const SPEAK_PERMISSION_CACHE_TTL_MS = 5_000;
const SPEAK_PERMISSION_CACHE_MAX_ENTRIES = 10_000;

type CachedSpeakPermission = {
	canSpeak: boolean;
	expiresAt: number;
};

const speakPermissionCache = new Map<string, CachedSpeakPermission>();

const cacheSpeakPermission = (key: string, value: CachedSpeakPermission) => {
	// Refresh insertion order for existing entries so the first key remains the
	// oldest one when the bounded cache needs to evict.
	speakPermissionCache.delete(key);

	if (speakPermissionCache.size >= SPEAK_PERMISSION_CACHE_MAX_ENTRIES) {
		const oldestKey = speakPermissionCache.keys().next().value;

		if (oldestKey !== undefined) {
			speakPermissionCache.delete(oldestKey);
		}
	}

	speakPermissionCache.set(key, value);
};

const updateVoiceActivityRoute = rateLimitedProcedure(protectedProcedure, {
	maxRequests: config.rateLimiters.voiceActivity.maxRequests,
	windowMs: config.rateLimiters.voiceActivity.windowMs,
	logLabel: 'voice.updateActivity',
	keyBy: 'user',
})
	.input(
		z.object({
			isSpeaking: z.boolean(),
			seq: z.number().int().nonnegative(),
			producerId: z.string().min(1),
		}),
	)
	.mutation(async ({ input, ctx }) => {
		const runtime = VoiceRuntime.requireJoinedRuntime(ctx.currentVoiceChannelId, ctx.user.id);
		const channelId = runtime.id;

		const cacheKey = `${ctx.user.id}:${channelId}`;
		const now = Date.now();
		const cached = speakPermissionCache.get(cacheKey);

		let canSpeak: boolean;

		if (cached && cached.expiresAt > now) {
			canSpeak = cached.canSpeak;
		} else {
			if (cached !== undefined) {
				speakPermissionCache.delete(cacheKey);
			}

			const [hasJoin, hasSpeak] = await Promise.all([
				ctx.hasPermission(Permission.JOIN_VOICE_CHANNELS),
				ctx.hasChannelPermission(channelId, ChannelPermission.SPEAK),
			]);
			canSpeak = hasJoin && hasSpeak;
			cacheSpeakPermission(cacheKey, { canSpeak, expiresAt: now + SPEAK_PERMISSION_CACHE_TTL_MS });
		}

		runtime.applyClientVoiceActivity(ctx.user.id, input.isSpeaking && canSpeak, input.seq, input.producerId);
	});

export { updateVoiceActivityRoute };
