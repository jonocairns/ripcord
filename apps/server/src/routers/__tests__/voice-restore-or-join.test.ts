import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ChannelType, ServerEvents } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken, initTest } from '../../__tests__/helpers';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { appRouter } from '../../routers';
import { VoiceRestoreAttemptSupersededError, VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';
import {
	clearPendingVoiceDisconnect,
	getPendingVoiceReconnectChannelId,
	resetVoiceDisconnectGraceForTests,
	schedulePendingVoiceDisconnect,
} from '../../utils/voice-disconnect-grace';
import {
	blockVoiceRestoreAfterKick,
	isVoiceRestoreBlockedAfterKick,
	resetVoiceKickGuardsForTests,
} from '../../utils/voice-kick-guard';
import {
	toRestoreOrJoinPublicError,
	VOICE_SESSION_OWNED_ELSEWHERE,
	VOICE_SESSION_WRONG_CHANNEL,
} from '../voice/restore-or-join';
import {
	VoiceRestoreAttemptCancelledError,
	VoiceRestoreAttemptSupersededServiceError,
} from '../voice/restore-or-join-service';

const PRIMARY_VOICE_CHANNEL_ID = 2;
const SECONDARY_VOICE_CHANNEL_ID = 3;

const createDeferred = () => {
	let resolvePromise: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});

	return { promise, resolve: resolvePromise };
};

const ensureVoiceRuntime = async (channelId: number, channelName: string): Promise<VoiceRuntime> => {
	const existingRuntime = VoiceRuntime.findById(channelId);

	if (existingRuntime) {
		return existingRuntime;
	}

	const existingChannel = await db.select().from(channels).where(eq(channels.id, channelId)).get();

	if (!existingChannel) {
		await db.insert(channels).values({
			id: channelId,
			type: ChannelType.VOICE,
			name: channelName,
			topic: `${channelName} topic`,
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

const attachTrackedSession = (
	ctx: Awaited<ReturnType<typeof createMockContext>>,
	session: {
		clientInstanceId: string;
		currentVoiceChannelId: number | undefined;
	},
	allSessions: Array<{
		clientInstanceId: string;
		currentVoiceChannelId: number | undefined;
	}>,
	opts?: { connectionClientInstanceId?: string },
) => {
	Reflect.set(ctx, 'getOwnWs', () => session);
	Reflect.set(ctx, 'getUserWss', () => allSessions);
	// getClientInstanceId reads the connection params, which stay populated even
	// when the tracked WS field (session.clientInstanceId) has not been set yet —
	// the handshake race. connectionClientInstanceId lets a test model that skew.
	const getClientInstanceId = () => opts?.connectionClientInstanceId ?? session.clientInstanceId;
	Reflect.set(ctx, 'getClientInstanceId', getClientInstanceId);
	Reflect.set(ctx, 'setWsVoiceChannelId', (channelId: number | undefined) => {
		session.currentVoiceChannelId = channelId;
		ctx.currentVoiceChannelId = channelId;
		if (channelId !== undefined) {
			clearPendingVoiceDisconnect(getClientInstanceId(), ctx.user.id);
		}
	});
};

afterEach(async () => {
	await clearVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID);
	await clearVoiceRuntime(SECONDARY_VOICE_CHANNEL_ID);
	resetVoiceDisconnectGraceForTests();
	resetVoiceKickGuardsForTests();
});

describe('voice.restoreOrJoin', () => {
	test('uses prepared pairs for join and restore while rebuild routes stay independently compatible', async () => {
		const runtime = await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');
		const preparePairSpy = spyOn(runtime, 'prepareTransportPair');
		const createProducerSpy = spyOn(runtime, 'createProducerTransport');
		const createConsumerSpy = spyOn(runtime, 'createConsumerTransport');
		const { caller } = await initTest(1);

		try {
			await caller.voice.restoreOrJoin({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
				reconnectAttemptId: 'prepared-fresh-bootstrap',
			});
			await caller.voice.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
			});
			await caller.voice.restoreOrJoin({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
				reconnectAttemptId: 'legacy-existing-bootstrap',
			});
			await caller.voice.createProducerTransport();
			await caller.voice.createConsumerTransport();

			expect(preparePairSpy).toHaveBeenCalledTimes(3);
			expect(createProducerSpy).toHaveBeenCalledTimes(1);
			expect(createConsumerSpy).toHaveBeenCalledTimes(1);
		} finally {
			preparePairSpy.mockRestore();
			createProducerSpy.mockRestore();
			createConsumerSpy.mockRestore();
		}
	});

	test('keeps cancellation and supersession compatible with the existing public error', () => {
		expect(toRestoreOrJoinPublicError(new VoiceRestoreAttemptCancelledError())).toBeInstanceOf(
			VoiceRestoreAttemptSupersededError,
		);
		expect(toRestoreOrJoinPublicError(new VoiceRestoreAttemptSupersededServiceError())).toBeInstanceOf(
			VoiceRestoreAttemptSupersededError,
		);
	});

	test('does not prepare transports when fresh restore permission resolution fails', async () => {
		const runtime = await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');
		const preparePairSpy = spyOn(runtime, 'prepareTransportPair');
		const ctx = await createMockContext({
			customToken: await getMockedToken(1),
		});
		const caller = appRouter.createCaller(ctx);
		const { handshakeHash } = await caller.others.handshake();
		await caller.others.joinServer({ handshakeHash });
		Reflect.set(ctx, 'needsPermission', async () => {
			throw new Error('Insufficient permissions');
		});

		try {
			await expect(
				caller.voice.restoreOrJoin({
					channelId: PRIMARY_VOICE_CHANNEL_ID,
					state: { micMuted: false, soundMuted: false },
					reconnectAttemptId: 'permission-failure',
				}),
			).rejects.toThrow('Insufficient permissions');
			expect(preparePairSpy).not.toHaveBeenCalled();
			expect(runtime.getUser(1)).toBeUndefined();
			expect(runtime.getProducerTransport(1)).toBeUndefined();
			expect(runtime.getConsumerTransport(1)).toBeUndefined();
		} finally {
			preparePairSpy.mockRestore();
		}
	});

	test('blocks a shipped client from automatically restoring voice after a kick', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');
		const ctx = await createMockContext({ customToken: await getMockedToken(1) });
		const caller = appRouter.createCaller(ctx);
		const { handshakeHash } = await caller.others.handshake();
		await caller.others.joinServer({ handshakeHash });

		const kickGuardIdentity = { clientInstanceId: ctx.getClientInstanceId(), token: ctx.token };
		blockVoiceRestoreAfterKick(ctx.user.id, kickGuardIdentity);

		await expect(
			caller.voice.restoreOrJoin({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: { micMuted: false, soundMuted: false },
				reconnectAttemptId: 'legacy-client-automatic-restore',
			}),
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeUndefined();
		expect(isVoiceRestoreBlockedAfterKick(ctx.user.id, kickGuardIdentity)).toBe(true);

		await caller.voice.join({
			channelId: PRIMARY_VOICE_CHANNEL_ID,
			state: { micMuted: false, soundMuted: false },
		});

		expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeDefined();
		expect(isVoiceRestoreBlockedAfterKick(ctx.user.id, kickGuardIdentity)).toBe(false);
	});

	test('joins normally and returns bootstrap when the user is not already in voice', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

		const joinEvents: Array<{ channelId: number; userId: number }> = [];
		const sessionReplacedEvents: number[] = [];
		const joinSub = pubsub.subscribe(ServerEvents.USER_JOIN_VOICE).subscribe({
			next: (event) => {
				joinEvents.push({
					channelId: event.channelId,
					userId: event.userId,
				});
			},
		});
		const replacedSub = pubsub.subscribeFor(1, ServerEvents.VOICE_SESSION_REPLACED).subscribe({
			next: (event) => {
				sessionReplacedEvents.push(event.channelId);
			},
		});

		try {
			const { caller } = await initTest(1);

			const result = await caller.voice.restoreOrJoin({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: true,
					soundMuted: false,
				},
				reconnectAttemptId: 'attempt-0',
			});

			expect(result.channelUsers).toContainEqual({
				userId: 1,
				state: {
					micMuted: true,
					soundMuted: false,
					webcamEnabled: false,
					sharingScreen: false,
				},
			});
			expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUserState(1)).toEqual({
				micMuted: true,
				soundMuted: false,
				webcamEnabled: false,
				sharingScreen: false,
			});
			expect(joinEvents).toEqual([
				{
					channelId: PRIMARY_VOICE_CHANNEL_ID,
					userId: 1,
				},
			]);
			expect(sessionReplacedEvents).toEqual([]);
		} finally {
			joinSub.unsubscribe();
			replacedSub.unsubscribe();
		}
	});

	test('returns bootstrap without join, leave, or session-replaced side effects for the same session', async () => {
		const runtime = await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

		const joinEvents: number[] = [];
		const leaveEvents: number[] = [];
		const sessionReplacedEvents: number[] = [];
		const joinSub = pubsub.subscribe(ServerEvents.USER_JOIN_VOICE).subscribe({
			next: (event) => {
				joinEvents.push(event.channelId);
			},
		});
		const leaveSub = pubsub.subscribe(ServerEvents.USER_LEAVE_VOICE).subscribe({
			next: (event) => {
				leaveEvents.push(event.channelId);
			},
		});
		const replacedSub = pubsub.subscribeFor(1, ServerEvents.VOICE_SESSION_REPLACED).subscribe({
			next: (event) => {
				sessionReplacedEvents.push(event.channelId);
			},
		});

		try {
			const { caller } = await initTest(1);

			await caller.voice.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
			});
			const oldProducerTransport = runtime.getProducerTransport(1);
			const oldConsumerTransport = runtime.getConsumerTransport(1);
			const sessionIncarnation = runtime.getVoiceSessionIncarnation(1);

			joinEvents.length = 0;
			leaveEvents.length = 0;
			sessionReplacedEvents.length = 0;

			const result = await caller.voice.restoreOrJoin({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
				reconnectAttemptId: 'attempt-1',
			});
			const replacementProducerTransport = runtime.getProducerTransport(1);
			const replacementConsumerTransport = runtime.getConsumerTransport(1);
			if (!replacementProducerTransport || !replacementConsumerTransport) {
				throw new Error('Expected restore to install both replacement transports');
			}

			expect(result.channelUsers.some((user) => user.userId === 1)).toBe(true);
			expect(result.producerTransportParams.id).toBe(replacementProducerTransport.id);
			expect(result.consumerTransportParams.id).toBe(replacementConsumerTransport.id);
			expect(oldProducerTransport?.closed).toBe(true);
			expect(oldConsumerTransport?.closed).toBe(true);
			expect(runtime.getVoiceSessionIncarnation(1)).toBe(sessionIncarnation);
			expect(joinEvents).toEqual([]);
			expect(leaveEvents).toEqual([]);
			expect(sessionReplacedEvents).toEqual([]);
		} finally {
			joinSub.unsubscribe();
			leaveSub.unsubscribe();
			replacedSub.unsubscribe();
		}
	});

	test('applies the restoring client state to an existing seat and notifies peers only on change', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

		const stateEvents: Array<{
			channelId: number;
			userId: number;
			micMuted: boolean;
			soundMuted: boolean;
		}> = [];
		const stateSub = pubsub.subscribe(ServerEvents.USER_VOICE_STATE_UPDATE).subscribe({
			next: (event) => {
				stateEvents.push({
					channelId: event.channelId,
					userId: event.userId,
					micMuted: event.state.micMuted,
					soundMuted: event.state.soundMuted,
				});
			},
		});

		try {
			const { caller } = await initTest(1);

			await caller.voice.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
			});

			// The seat predates this restore (surviving seat, or one adopted from a
			// superseded attempt). A mute toggled since must land on the seat, be
			// returned in the bootstrap, and reach peers — nothing reconciles it
			// after restore otherwise.
			const result = await caller.voice.restoreOrJoin({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: true,
					soundMuted: false,
				},
				reconnectAttemptId: 'attempt-1',
			});

			expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUserState(1)).toMatchObject({
				micMuted: true,
				soundMuted: false,
			});
			expect(result.channelUsers).toContainEqual(
				expect.objectContaining({
					userId: 1,
					state: expect.objectContaining({ micMuted: true, soundMuted: false }),
				}),
			);
			expect(stateEvents).toEqual([
				{
					channelId: PRIMARY_VOICE_CHANNEL_ID,
					userId: 1,
					micMuted: true,
					soundMuted: false,
				},
			]);

			stateEvents.length = 0;

			// Restoring with unchanged state must not spam peers with updates.
			await caller.voice.restoreOrJoin({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: true,
					soundMuted: false,
				},
				reconnectAttemptId: 'attempt-2',
			});

			expect(stateEvents).toEqual([]);
		} finally {
			stateSub.unsubscribe();
		}
	});

	test('forced reconnect-lab restore failures are one-shot', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

		const { caller } = await initTest(1);

		await caller.voice.join({
			channelId: PRIMARY_VOICE_CHANNEL_ID,
			state: {
				micMuted: false,
				soundMuted: false,
			},
		});

		await caller.voice.reconnectLab.setNextRestoreBehavior({
			failMessage: 'VOICE_RECONNECT_LAB_FORCED_FAILURE',
		});

		await expect(
			caller.voice.restoreOrJoin({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
				reconnectAttemptId: 'attempt-restore-lab-fail',
			}),
		).rejects.toThrow('VOICE_RECONNECT_LAB_FORCED_FAILURE');

		const result = await caller.voice.restoreOrJoin({
			channelId: PRIMARY_VOICE_CHANNEL_ID,
			state: {
				micMuted: false,
				soundMuted: false,
			},
			reconnectAttemptId: 'attempt-restore-lab-retry',
		});

		expect(result.channelUsers.some((user) => user.userId === 1)).toBe(true);
	});

	test('does not commit transports created by a superseded restore attempt', async () => {
		const runtime = await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		let staleAttemptCurrent = true;
		const staleProducer = runtime
			.createProducerTransport(1, () => staleAttemptCurrent)
			.catch((error: unknown) => error);
		const staleConsumer = runtime
			.createConsumerTransport(1, () => staleAttemptCurrent)
			.catch((error: unknown) => error);
		staleAttemptCurrent = false;

		const [producerParams, consumerParams] = await Promise.all([
			runtime.createProducerTransport(1),
			runtime.createConsumerTransport(1),
		]);

		expect(await staleProducer).toEqual(expect.objectContaining({ message: 'Voice restore attempt superseded' }));
		expect(await staleConsumer).toEqual(expect.objectContaining({ message: 'Voice restore attempt superseded' }));
		expect(runtime.getProducerTransport(1)?.id).toBe(producerParams.id);
		expect(runtime.getConsumerTransport(1)?.id).toBe(consumerParams.id);
	});

	test('forgetOwnVoiceSession drops the server-side voice session and broadcasts a reconnecting leave', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

		const leaveEvents: {
			channelId: number;
			userId: number;
			reconnecting?: boolean;
		}[] = [];
		const leaveSub = pubsub.subscribe(ServerEvents.USER_LEAVE_VOICE).subscribe({
			next: (event) => {
				leaveEvents.push(event);
			},
		});

		try {
			const { caller } = await initTest(1);

			await caller.voice.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
			});

			leaveEvents.length = 0;

			const result = await caller.voice.reconnectLab.forgetOwnVoiceSession();

			expect(result).toEqual({
				forgotten: true,
				channelId: PRIMARY_VOICE_CHANNEL_ID,
			});
			expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeUndefined();
			expect(leaveEvents).toEqual([
				{
					channelId: PRIMARY_VOICE_CHANNEL_ID,
					userId: 1,
					reconnecting: true,
				},
			]);
		} finally {
			leaveSub.unsubscribe();
		}
	});

	test('returns CONFLICT when the active voice session is in a different channel', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');
		await ensureVoiceRuntime(SECONDARY_VOICE_CHANNEL_ID, 'Voice 2');

		const { caller } = await initTest(1);

		await caller.voice.join({
			channelId: PRIMARY_VOICE_CHANNEL_ID,
			state: {
				micMuted: false,
				soundMuted: false,
			},
		});

		await expect(
			caller.voice.restoreOrJoin({
				channelId: SECONDARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
				reconnectAttemptId: 'attempt-2',
			}),
		).rejects.toThrow(VOICE_SESSION_WRONG_CHANNEL);

		expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeDefined();
		expect(VoiceRuntime.findById(SECONDARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeUndefined();
	});

	test('allows restore when another open socket belongs to the same client instance', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

		const mockedToken = await getMockedToken(1);
		const ctxA = await createMockContext({
			customToken: mockedToken,
		});
		const ctxB = await createMockContext({
			customToken: mockedToken,
		});
		const sessionA = {
			clientInstanceId: 'shared-client',
			currentVoiceChannelId: undefined as number | undefined,
		};
		const sessionB = {
			clientInstanceId: 'shared-client',
			currentVoiceChannelId: undefined as number | undefined,
		};
		const trackedSessions = [sessionA, sessionB];

		attachTrackedSession(ctxA, sessionA, trackedSessions);
		attachTrackedSession(ctxB, sessionB, trackedSessions);

		const sessionReplacedEvents: number[] = [];
		const replacedSub = pubsub.subscribeFor(1, ServerEvents.VOICE_SESSION_REPLACED).subscribe({
			next: (event) => {
				sessionReplacedEvents.push(event.channelId);
			},
		});

		try {
			const callerA = appRouter.createCaller(ctxA);
			const callerB = appRouter.createCaller(ctxB);
			const handshakeA = await callerA.others.handshake();
			const handshakeB = await callerB.others.handshake();

			await callerA.others.joinServer({
				handshakeHash: handshakeA.handshakeHash,
			});
			await callerB.others.joinServer({
				handshakeHash: handshakeB.handshakeHash,
			});

			await callerA.voice.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
			});

			const result = await callerB.voice.restoreOrJoin({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
				reconnectAttemptId: 'attempt-same-client-overlap',
			});

			expect(result.channelUsers.some((user) => user.userId === 1)).toBe(true);
			expect(sessionA.currentVoiceChannelId).toBe(PRIMARY_VOICE_CHANNEL_ID);
			expect(sessionB.currentVoiceChannelId).toBe(PRIMARY_VOICE_CHANNEL_ID);
			expect(sessionReplacedEvents).toEqual([]);
		} finally {
			replacedSub.unsubscribe();
		}
	});

	test('returns CONFLICT without eviction when another active session owns the requested channel', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

		const mockedToken = await getMockedToken(1);
		const ctxA = await createMockContext({
			customToken: mockedToken,
		});
		const ctxB = await createMockContext({
			customToken: mockedToken,
		});
		const sessionA = {
			clientInstanceId: 'session-a',
			currentVoiceChannelId: undefined as number | undefined,
		};
		const sessionB = {
			clientInstanceId: 'session-b',
			currentVoiceChannelId: undefined as number | undefined,
		};
		const trackedSessions = [sessionA, sessionB];

		attachTrackedSession(ctxA, sessionA, trackedSessions);
		attachTrackedSession(ctxB, sessionB, trackedSessions);

		const sessionReplacedEvents: number[] = [];
		const replacedSub = pubsub.subscribeFor(1, ServerEvents.VOICE_SESSION_REPLACED).subscribe({
			next: (event) => {
				sessionReplacedEvents.push(event.channelId);
			},
		});

		try {
			const callerA = appRouter.createCaller(ctxA);
			const callerB = appRouter.createCaller(ctxB);
			const handshakeA = await callerA.others.handshake();
			const handshakeB = await callerB.others.handshake();

			await callerA.others.joinServer({
				handshakeHash: handshakeA.handshakeHash,
			});
			await callerB.others.joinServer({
				handshakeHash: handshakeB.handshakeHash,
			});

			await callerA.voice.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
			});

			expect(sessionA.currentVoiceChannelId).toBe(PRIMARY_VOICE_CHANNEL_ID);

			await expect(
				callerB.voice.restoreOrJoin({
					channelId: PRIMARY_VOICE_CHANNEL_ID,
					state: {
						micMuted: false,
						soundMuted: false,
					},
					reconnectAttemptId: 'attempt-3',
				}),
			).rejects.toThrow(VOICE_SESSION_OWNED_ELSEWHERE);

			expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeDefined();
			expect(sessionReplacedEvents).toEqual([]);
		} finally {
			replacedSub.unsubscribe();
		}
	});

	test('returns CONFLICT when another client instance owns the pending reconnect grace for the channel', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

		const mockedToken = await getMockedToken(1);
		const ctxA = await createMockContext({
			customToken: mockedToken,
		});
		const ctxB = await createMockContext({
			customToken: mockedToken,
		});
		const sessionA = {
			clientInstanceId: 'session-a',
			currentVoiceChannelId: undefined as number | undefined,
		};
		const sessionB = {
			clientInstanceId: 'session-b',
			currentVoiceChannelId: undefined as number | undefined,
		};
		const openSessions = [sessionA];

		attachTrackedSession(ctxA, sessionA, openSessions);
		attachTrackedSession(ctxB, sessionB, [sessionB]);

		try {
			const callerA = appRouter.createCaller(ctxA);
			const callerB = appRouter.createCaller(ctxB);
			const handshakeA = await callerA.others.handshake();
			const handshakeB = await callerB.others.handshake();

			await callerA.others.joinServer({
				handshakeHash: handshakeA.handshakeHash,
			});
			await callerB.others.joinServer({
				handshakeHash: handshakeB.handshakeHash,
			});

			await callerA.voice.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
			});

			openSessions.length = 0;

			schedulePendingVoiceDisconnect({
				clientInstanceId: sessionA.clientInstanceId,
				userId: 1,
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				finalize: () => {},
			});

			await expect(
				callerB.voice.restoreOrJoin({
					channelId: PRIMARY_VOICE_CHANNEL_ID,
					state: {
						micMuted: false,
						soundMuted: false,
					},
					reconnectAttemptId: 'attempt-pending-grace-conflict',
				}),
			).rejects.toThrow(VOICE_SESSION_OWNED_ELSEWHERE);

			expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeDefined();
		} finally {
			openSessions.length = 0;
		}
	});

	test('restores its own pending grace seat when the tracked socket has not populated its clientInstanceId yet', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

		const mockedToken = await getMockedToken(1);
		const ctxA = await createMockContext({
			customToken: mockedToken,
		});
		const ctxB = await createMockContext({
			customToken: mockedToken,
		});
		const sessionA = {
			clientInstanceId: 'session-a',
			currentVoiceChannelId: undefined as number | undefined,
		};
		// The reconnected socket is the same client instance reconnecting, but its
		// tracked WS field has not been populated yet (handshake race). The
		// connection params still carry 'session-a', so restoreOrJoin must resolve
		// the id via ctx.getClientInstanceId() and recognise the pending grace seat
		// as its own instead of rejecting the reconnect with a terminal CONFLICT.
		const sessionB = {
			clientInstanceId: undefined as unknown as string,
			currentVoiceChannelId: undefined as number | undefined,
		};
		const openSessions = [sessionA];

		attachTrackedSession(ctxA, sessionA, openSessions);
		attachTrackedSession(ctxB, sessionB, [sessionB], { connectionClientInstanceId: 'session-a' });

		try {
			const callerA = appRouter.createCaller(ctxA);
			const callerB = appRouter.createCaller(ctxB);
			const handshakeA = await callerA.others.handshake();
			const handshakeB = await callerB.others.handshake();

			await callerA.others.joinServer({
				handshakeHash: handshakeA.handshakeHash,
			});
			await callerB.others.joinServer({
				handshakeHash: handshakeB.handshakeHash,
			});

			await callerA.voice.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
			});

			openSessions.length = 0;

			let finalized = false;
			schedulePendingVoiceDisconnect({
				clientInstanceId: sessionA.clientInstanceId,
				userId: 1,
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				finalize: () => {
					finalized = true;
				},
			});
			expect(getPendingVoiceReconnectChannelId(sessionA.clientInstanceId, 1)).toBe(PRIMARY_VOICE_CHANNEL_ID);

			const result = await callerB.voice.restoreOrJoin({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
				reconnectAttemptId: 'attempt-pending-grace-restore',
			});

			expect(result.channelUsers.some((entry) => entry.userId === 1)).toBe(true);
			expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeDefined();
			expect(getPendingVoiceReconnectChannelId(sessionA.clientInstanceId, 1)).toBeUndefined();
			expect(finalized).toBe(false);
		} finally {
			openSessions.length = 0;
		}
	});
});

describe('voice session incarnation ownership', () => {
	test('join preparation failure preserves the established session and publishes nothing', async () => {
		const primaryRuntime = await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');
		const secondaryRuntime = await ensureVoiceRuntime(SECONDARY_VOICE_CHANNEL_ID, 'Other voice');
		const ctx = await createMockContext({ customToken: await getMockedToken(1) });
		const caller = appRouter.createCaller(ctx);
		const { handshakeHash } = await caller.others.handshake();
		await caller.others.joinServer({ handshakeHash });
		await caller.voice.join({
			channelId: PRIMARY_VOICE_CHANNEL_ID,
			state: { micMuted: false, soundMuted: false },
			mutationSeq: 0,
		});
		const establishedIdentity = primaryRuntime.getVoiceSessionIdentity(1);
		const failure = new Error('target allocation failed');
		const preparePairSpy = spyOn(secondaryRuntime, 'prepareTransportPair').mockRejectedValue(failure);
		const events: string[] = [];
		const leaveSub = pubsub.subscribe(ServerEvents.USER_LEAVE_VOICE).subscribe({
			next: () => events.push('leave'),
		});
		const replacedSub = pubsub.subscribeFor(1, ServerEvents.VOICE_SESSION_REPLACED).subscribe({
			next: () => events.push('session-replaced'),
		});
		const joinSub = pubsub.subscribe(ServerEvents.USER_JOIN_VOICE).subscribe({
			next: () => events.push('join'),
		});

		try {
			await expect(
				caller.voice.join({
					channelId: SECONDARY_VOICE_CHANNEL_ID,
					state: { micMuted: true, soundMuted: false },
					mutationSeq: 1,
				}),
			).rejects.toThrow(failure.message);
			expect(primaryRuntime.getVoiceSessionIdentity(1)).toEqual(establishedIdentity);
			expect(secondaryRuntime.getUser(1)).toBeUndefined();
			expect(ctx.currentVoiceChannelId).toBe(PRIMARY_VOICE_CHANNEL_ID);
			expect(events).toEqual([]);
		} finally {
			preparePairSpy.mockRestore();
			leaveSub.unsubscribe();
			replacedSub.unsubscribe();
			joinSub.unsubscribe();
		}
	});

	test('two overlapping joins commit only the newest target', async () => {
		const primaryRuntime = await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');
		const secondaryRuntime = await ensureVoiceRuntime(SECONDARY_VOICE_CHANNEL_ID, 'Other voice');
		const ctx = await createMockContext({ customToken: await getMockedToken(1) });
		const caller = appRouter.createCaller(ctx);
		const { handshakeHash } = await caller.others.handshake();
		await caller.others.joinServer({ handshakeHash });
		const entered = createDeferred();
		const release = createDeferred();
		const originalNeedsChannelPermission = ctx.needsChannelPermission;
		Reflect.set(
			ctx,
			'needsChannelPermission',
			async (...args: Parameters<typeof originalNeedsChannelPermission>): Promise<void> => {
				await originalNeedsChannelPermission(...args);
				if (args[0] === PRIMARY_VOICE_CHANNEL_ID) {
					entered.resolve();
					await release.promise;
				}
			},
		);

		const staleJoin = caller.voice
			.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: { micMuted: false, soundMuted: false },
				mutationSeq: 1,
			})
			.catch((error: unknown) => error);
		await entered.promise;
		await caller.voice.join({
			channelId: SECONDARY_VOICE_CHANNEL_ID,
			state: { micMuted: true, soundMuted: false },
			mutationSeq: 2,
		});
		release.resolve();

		expect(await staleJoin).toMatchObject({ code: 'CONFLICT' });
		expect(primaryRuntime.getUser(1)).toBeUndefined();
		expect(secondaryRuntime.getUserState(1).micMuted).toBe(true);
		expect(ctx.currentVoiceChannelId).toBe(SECONDARY_VOICE_CHANNEL_ID);
	});

	test('a delayed standalone rebuild cannot install over a replacement join', async () => {
		const runtime = await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');
		const ctx = await createMockContext({ customToken: await getMockedToken(1) });
		const caller = appRouter.createCaller(ctx);
		const { handshakeHash } = await caller.others.handshake();
		await caller.others.joinServer({ handshakeHash });
		await caller.voice.join({
			channelId: PRIMARY_VOICE_CHANNEL_ID,
			state: { micMuted: false, soundMuted: false },
			mutationSeq: 0,
		});
		const entered = createDeferred();
		const release = createDeferred();
		const originalCreateTransport = runtime.createTransport;
		let allocationCount = 0;
		const createTransportSpy = spyOn(runtime, 'createTransport').mockImplementation(async (bitrate) => {
			allocationCount += 1;
			const allocation = await originalCreateTransport(bitrate);
			if (allocationCount === 1) {
				entered.resolve();
				await release.promise;
			}
			return allocation;
		});

		try {
			const staleRebuild = caller.voice.createProducerTransport().catch((error: unknown) => error);
			await entered.promise;
			await caller.voice.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: { micMuted: true, soundMuted: false },
				mutationSeq: 1,
			});
			const committedProducer = runtime.getProducerTransport(1);
			release.resolve();

			expect(await staleRebuild).toMatchObject({ message: 'Voice restore attempt superseded' });
			expect(runtime.getProducerTransport(1)).toBe(committedProducer);
			expect(runtime.getUserState(1).micMuted).toBe(true);
		} finally {
			release.resolve();
			createTransportSpy.mockRestore();
		}
	});

	test('a newer leave mutation prevents a delayed join from committing', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');
		await ensureVoiceRuntime(SECONDARY_VOICE_CHANNEL_ID, 'Other voice');

		const ctx = await createMockContext({
			customToken: await getMockedToken(1),
		});
		const caller = appRouter.createCaller(ctx);
		const { handshakeHash } = await caller.others.handshake();
		await caller.others.joinServer({ handshakeHash });

		await caller.voice.join({
			channelId: PRIMARY_VOICE_CHANNEL_ID,
			state: {
				micMuted: false,
				soundMuted: false,
			},
			mutationSeq: 0,
		});

		let markDelayedJoinStarted: (() => void) | undefined;
		const delayedJoinStarted = new Promise<void>((resolve) => {
			markDelayedJoinStarted = resolve;
		});
		let releaseDelayedJoin: (() => void) | undefined;
		const waitBeforeJoinTargetResolve = new Promise<void>((resolve) => {
			releaseDelayedJoin = resolve;
		});
		const originalNeedsChannelPermission = ctx.needsChannelPermission;
		Reflect.set(
			ctx,
			'needsChannelPermission',
			async (...args: Parameters<typeof originalNeedsChannelPermission>): Promise<void> => {
				await originalNeedsChannelPermission(...args);
				if (args[0] === SECONDARY_VOICE_CHANNEL_ID) {
					markDelayedJoinStarted?.();
					await waitBeforeJoinTargetResolve;
				}
			},
		);

		const delayedJoin = caller.voice
			.join({
				channelId: SECONDARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
				mutationSeq: 1,
			})
			.then(
				() => ({ kind: 'resolved' as const }),
				(error: unknown) => ({ kind: 'rejected' as const, error }),
			);

		await delayedJoinStarted;
		await caller.voice.leave({ mutationSeq: 2 });
		releaseDelayedJoin?.();

		const delayedJoinOutcome = await delayedJoin;
		expect(delayedJoinOutcome.kind).toBe('rejected');
		if (delayedJoinOutcome.kind === 'resolved') {
			throw new Error('Expected the delayed join to be superseded');
		}
		expect(delayedJoinOutcome.error).toMatchObject({
			code: 'CONFLICT',
		});
		expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeUndefined();
		expect(VoiceRuntime.findById(SECONDARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeUndefined();
		expect(ctx.currentVoiceChannelId).toBeUndefined();
	});

	test('a delayed leave from a replaced session does not remove the replacement', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

		const mockedToken = await getMockedToken(1);
		const ctxA = await createMockContext({
			customToken: mockedToken,
		});
		const ctxB = await createMockContext({
			customToken: mockedToken,
		});
		const sessionA = {
			clientInstanceId: 'incarnation-a',
			currentVoiceChannelId: undefined as number | undefined,
		};
		const sessionB = {
			clientInstanceId: 'incarnation-b',
			currentVoiceChannelId: undefined as number | undefined,
		};
		const trackedSessions = [sessionA, sessionB];

		attachTrackedSession(ctxA, sessionA, trackedSessions);
		attachTrackedSession(ctxB, sessionB, trackedSessions);

		const leaveEvents: number[] = [];
		const leaveSub = pubsub.subscribe(ServerEvents.USER_LEAVE_VOICE).subscribe({
			next: (event) => {
				leaveEvents.push(event.channelId);
			},
		});

		try {
			const callerA = appRouter.createCaller(ctxA);
			const callerB = appRouter.createCaller(ctxB);
			const handshakeA = await callerA.others.handshake();
			const handshakeB = await callerB.others.handshake();

			await callerA.others.joinServer({
				handshakeHash: handshakeA.handshakeHash,
			});
			await callerB.others.joinServer({
				handshakeHash: handshakeB.handshakeHash,
			});

			await callerA.voice.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: false,
					soundMuted: false,
				},
			});

			// B's join replaces A's session in the same channel: one eviction leave.
			await callerB.voice.join({
				channelId: PRIMARY_VOICE_CHANNEL_ID,
				state: {
					micMuted: true,
					soundMuted: false,
				},
			});
			expect(leaveEvents).toEqual([PRIMARY_VOICE_CHANNEL_ID]);

			// A's delayed leave still references its replaced session, so it must
			// not remove B's seat and must not publish another leave.
			await callerA.voice.leave();

			expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeDefined();
			expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUserState(1)?.micMuted).toBe(true);
			expect(leaveEvents).toEqual([PRIMARY_VOICE_CHANNEL_ID]);
			expect(ctxA.currentVoiceChannelId).toBeUndefined();
			expect(ctxB.currentVoiceChannelId).toBe(PRIMARY_VOICE_CHANNEL_ID);

			// The owning session's leave still works.
			await callerB.voice.leave();

			expect(VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.getUser(1)).toBeUndefined();
			expect(leaveEvents).toEqual([PRIMARY_VOICE_CHANNEL_ID, PRIMARY_VOICE_CHANNEL_ID]);
			expect(ctxB.currentVoiceChannelId).toBeUndefined();
		} finally {
			leaveSub.unsubscribe();
		}
	});

	test('a leave whose seat is already gone is a graceful no-op', async () => {
		await ensureVoiceRuntime(PRIMARY_VOICE_CHANNEL_ID, 'Voice');

		const { caller } = await initTest(1);

		await caller.voice.join({
			channelId: PRIMARY_VOICE_CHANNEL_ID,
			state: {
				micMuted: false,
				soundMuted: false,
			},
		});

		// Simulate the seat disappearing out from under this connection (e.g. a
		// disconnect-grace expiry on another socket).
		VoiceRuntime.findById(PRIMARY_VOICE_CHANNEL_ID)?.removeUser(1);

		const leaveEvents: number[] = [];
		const leaveSub = pubsub.subscribe(ServerEvents.USER_LEAVE_VOICE).subscribe({
			next: (event) => {
				leaveEvents.push(event.channelId);
			},
		});

		try {
			await expect(caller.voice.leave()).resolves.toBeUndefined();
			expect(leaveEvents).toEqual([]);
		} finally {
			leaveSub.unsubscribe();
		}
	});
});
