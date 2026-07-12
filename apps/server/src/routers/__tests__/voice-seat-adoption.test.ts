import { afterEach, describe, expect, test } from 'bun:test';
import { ChannelType } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken } from '../../__tests__/helpers';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { appRouter } from '../../routers';
import { VoiceRuntime } from '../../runtimes/voice';
import {
	getPendingVoiceReconnectChannelId,
	resetVoiceDisconnectGraceForTests,
	schedulePendingVoiceDisconnect,
} from '../../utils/voice-disconnect-grace';

const VOICE_CHANNEL_ID = 2;
// Must match the clientInstanceId baked into createMockContext's connection params.
const MOCK_CLIENT_INSTANCE_ID = 'test-client-instance';

const ensureVoiceRuntime = async (channelId: number): Promise<VoiceRuntime> => {
	const existingRuntime = VoiceRuntime.findById(channelId);

	if (existingRuntime) {
		return existingRuntime;
	}

	const existingChannel = await db.select().from(channels).where(eq(channels.id, channelId)).get();

	if (!existingChannel) {
		await db.insert(channels).values({
			id: channelId,
			type: ChannelType.VOICE,
			name: 'Voice',
			topic: 'Voice topic',
			fileAccessToken: crypto.randomUUID(),
			fileAccessTokenUpdatedAt: Date.now(),
			position: channelId - 1,
			categoryId: 2,
			createdAt: Date.now(),
		});
	}

	const runtime = new VoiceRuntime(channelId);
	await runtime.init();

	return runtime;
};

const clearVoiceRuntime = async (channelId: number) => {
	const runtime = VoiceRuntime.findById(channelId);

	if (!runtime) {
		return;
	}

	[...runtime.getState().users].forEach((user) => {
		runtime.removeUser(user.userId);
	});

	await runtime.destroy();
};

const joinServerWithOwnContext = async (userId: number) => {
	const ctx = await createMockContext({
		customToken: await getMockedToken(userId),
	});
	const caller = appRouter.createCaller(ctx);
	const { handshakeHash } = await caller.others.handshake();

	await caller.others.joinServer({ handshakeHash });

	return ctx;
};

afterEach(async () => {
	await clearVoiceRuntime(VOICE_CHANNEL_ID);
	resetVoiceDisconnectGraceForTests();
});

describe('joinServer voice seat adoption', () => {
	test('adopts the pending seat when its incarnation is unchanged since disconnect', async () => {
		const runtime = await ensureVoiceRuntime(VOICE_CHANNEL_ID);

		runtime.addUser(1, { micMuted: false, soundMuted: false });
		schedulePendingVoiceDisconnect({
			clientInstanceId: MOCK_CLIENT_INSTANCE_ID,
			userId: 1,
			channelId: VOICE_CHANNEL_ID,
			seatIncarnation: runtime.getVoiceSessionIncarnation(1),
			finalize: () => {},
			ttlMs: 60_000,
		});

		const ctx = await joinServerWithOwnContext(1);

		expect(ctx.currentVoiceChannelId).toBe(VOICE_CHANNEL_ID);
		expect(ctx.currentVoiceSessionIncarnation).toBe(runtime.getVoiceSessionIncarnation(1));
		// Adoption re-bound the socket, which cancels the grace timer.
		expect(getPendingVoiceReconnectChannelId(MOCK_CLIENT_INSTANCE_ID, 1)).toBeUndefined();
	});

	test('does not adopt a seat that a newer session replaced during the disconnect', async () => {
		const runtime = await ensureVoiceRuntime(VOICE_CHANNEL_ID);

		runtime.addUser(1, { micMuted: false, soundMuted: false });
		schedulePendingVoiceDisconnect({
			clientInstanceId: MOCK_CLIENT_INSTANCE_ID,
			userId: 1,
			channelId: VOICE_CHANNEL_ID,
			seatIncarnation: runtime.getVoiceSessionIncarnation(1),
			finalize: () => {},
			ttlMs: 60_000,
		});

		// Another connection takes the seat over while this client is away: the
		// seat is re-minted with a new incarnation.
		runtime.removeUser(1);
		runtime.addUser(1, { micMuted: true, soundMuted: false });

		const ctx = await joinServerWithOwnContext(1);

		// Binding here would hand this connection the successor's seat, letting a
		// later give-up or quit-flush leave evict it.
		expect(ctx.currentVoiceChannelId).toBeUndefined();
		expect(ctx.currentVoiceSessionIncarnation).toBeUndefined();
		// The stale grace entry stays; its finalize no-ops while the successor has
		// a live voice connection in the channel.
		expect(getPendingVoiceReconnectChannelId(MOCK_CLIENT_INSTANCE_ID, 1)).toBe(VOICE_CHANNEL_ID);
	});
});
