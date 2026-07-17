import { afterEach, describe, expect, test } from 'bun:test';
import { DisconnectCode } from '@sharkord/shared';
import { VoiceRuntime } from '../../runtimes/voice';
import {
	clearPendingVoiceDisconnect,
	getPendingVoiceReconnectChannelId,
	getPendingVoiceReconnectSeatIncarnation,
	getVoiceDisconnectGraceCounters,
	resetVoiceDisconnectGraceForTests,
	schedulePendingVoiceDisconnect,
	setVoiceDisconnectGraceSchedulerForTests,
	shouldScheduleVoiceDisconnectGrace,
	type TVoiceDisconnectGraceScheduler,
} from '../voice-disconnect-grace';

const createTestScheduler = () => {
	type TTask = {
		cancelled: boolean;
		runAt: number;
		callback: () => void;
	};

	let now = 0;
	const tasks: TTask[] = [];
	const scheduler: TVoiceDisconnectGraceScheduler = {
		now: () => now,
		schedule: (callback, delayMs) => {
			const task: TTask = { cancelled: false, runAt: now + delayMs, callback };
			tasks.push(task);
			return { cancel: () => (task.cancelled = true) };
		},
	};

	return {
		scheduler,
		advanceBy: (durationMs: number) => {
			const target = now + durationMs;

			while (true) {
				const nextTask = tasks
					.filter((task) => !task.cancelled && task.runAt <= target)
					.sort((left, right) => left.runAt - right.runAt)[0];

				if (!nextTask) {
					break;
				}

				nextTask.cancelled = true;
				now = nextTask.runAt;
				nextTask.callback();
			}

			now = target;
		},
	};
};

afterEach(() => {
	resetVoiceDisconnectGraceForTests();
	setVoiceDisconnectGraceSchedulerForTests();
});

describe('voice disconnect grace', () => {
	test('only preserves reconnect grace for recoverable closes', () => {
		expect(shouldScheduleVoiceDisconnectGrace(DisconnectCode.UNEXPECTED)).toBe(true);
		expect(shouldScheduleVoiceDisconnectGrace(DisconnectCode.SERVER_SHUTDOWN)).toBe(true);
		expect(shouldScheduleVoiceDisconnectGrace(DisconnectCode.KICKED)).toBe(false);
		expect(shouldScheduleVoiceDisconnectGrace(DisconnectCode.BANNED)).toBe(false);
	});

	test('stores the seat incarnation for the matching entry and drops it on cancel', () => {
		const seatIncarnation = Symbol('seat');

		schedulePendingVoiceDisconnect({
			clientInstanceId: 'client-a',
			userId: 7,
			channelId: 2,
			seatIncarnation,
			finalize: () => {},
			ttlMs: 1_000,
		});

		expect(getPendingVoiceReconnectSeatIncarnation('client-a', 7)).toBe(seatIncarnation);
		expect(getPendingVoiceReconnectSeatIncarnation('client-b', 7)).toBeUndefined();
		expect(getPendingVoiceReconnectSeatIncarnation(undefined, 7)).toBeUndefined();

		clearPendingVoiceDisconnect('client-a', 7);

		expect(getPendingVoiceReconnectSeatIncarnation('client-a', 7)).toBeUndefined();
	});

	test('cancels only the matching clientInstanceId grace entry', () => {
		const testScheduler = createTestScheduler();
		setVoiceDisconnectGraceSchedulerForTests(testScheduler.scheduler);
		const finalized: string[] = [];

		schedulePendingVoiceDisconnect({
			clientInstanceId: 'client-a',
			userId: 7,
			channelId: 2,
			finalize: () => {
				finalized.push('client-a');
			},
			ttlMs: 15,
		});

		schedulePendingVoiceDisconnect({
			clientInstanceId: 'client-b',
			userId: 7,
			channelId: 2,
			finalize: () => {
				finalized.push('client-b');
			},
			ttlMs: 15,
		});

		expect(getPendingVoiceReconnectChannelId('client-a', 7)).toBe(2);
		expect(getPendingVoiceReconnectChannelId('client-b', 7)).toBe(2);

		expect(clearPendingVoiceDisconnect('client-a', 7)).toBe(true);
		expect(getPendingVoiceReconnectChannelId('client-a', 7)).toBeUndefined();
		expect(getPendingVoiceReconnectChannelId('client-b', 7)).toBe(2);

		testScheduler.advanceBy(15);

		expect(finalized).toEqual(['client-b']);
		expect(getVoiceDisconnectGraceCounters()).toEqual({
			graceScheduled: 2,
			graceCancelled: 1,
			graceExpired: 1,
			missingClientInstanceId: 0,
		});
	});

	test('does not expose pending reconnect state to the wrong user', () => {
		schedulePendingVoiceDisconnect({
			clientInstanceId: 'client-a',
			userId: 7,
			channelId: 2,
			finalize: () => {},
			ttlMs: 100,
		});

		expect(getPendingVoiceReconnectChannelId('client-a', 7)).toBe(2);
		expect(getPendingVoiceReconnectChannelId('client-a', 8)).toBeUndefined();
	});

	test('does not let one user cancel another user with the same clientInstanceId', () => {
		const testScheduler = createTestScheduler();
		setVoiceDisconnectGraceSchedulerForTests(testScheduler.scheduler);
		const finalized: string[] = [];

		schedulePendingVoiceDisconnect({
			clientInstanceId: 'shared-client',
			userId: 7,
			channelId: 2,
			finalize: () => {
				finalized.push('user-7');
			},
			ttlMs: 15,
		});

		schedulePendingVoiceDisconnect({
			clientInstanceId: 'shared-client',
			userId: 8,
			channelId: 3,
			finalize: () => {
				finalized.push('user-8');
			},
			ttlMs: 15,
		});

		expect(getPendingVoiceReconnectChannelId('shared-client', 7)).toBe(2);
		expect(getPendingVoiceReconnectChannelId('shared-client', 8)).toBe(3);

		expect(clearPendingVoiceDisconnect('shared-client', 8)).toBe(true);
		expect(getPendingVoiceReconnectChannelId('shared-client', 7)).toBe(2);
		expect(getPendingVoiceReconnectChannelId('shared-client', 8)).toBeUndefined();

		testScheduler.advanceBy(15);

		expect(finalized).toEqual(['user-7']);
	});

	test('falls back to a short uncancellable grace when clientInstanceId is missing', () => {
		const testScheduler = createTestScheduler();
		setVoiceDisconnectGraceSchedulerForTests(testScheduler.scheduler);
		let finalized = 0;

		schedulePendingVoiceDisconnect({
			userId: 7,
			channelId: 2,
			finalize: () => {
				finalized += 1;
			},
			fallbackTtlMs: 15,
		});

		expect(getPendingVoiceReconnectChannelId(undefined, 7)).toBeUndefined();
		expect(clearPendingVoiceDisconnect(undefined)).toBe(false);

		testScheduler.advanceBy(15);

		expect(finalized).toBe(1);
		expect(getVoiceDisconnectGraceCounters()).toEqual({
			graceScheduled: 1,
			graceCancelled: 0,
			graceExpired: 1,
			missingClientInstanceId: 1,
		});
	});

	test('expiry cannot remove a successor incarnation', async () => {
		const testScheduler = createTestScheduler();
		setVoiceDisconnectGraceSchedulerForTests(testScheduler.scheduler);
		const runtime = new VoiceRuntime(99_901);
		await runtime.init();

		try {
			runtime.addUser(7, { micMuted: false, soundMuted: false });
			const disconnectedIncarnation = runtime.getVoiceSessionIncarnation(7);

			schedulePendingVoiceDisconnect({
				clientInstanceId: 'client-a',
				userId: 7,
				channelId: runtime.id,
				seatIncarnation: disconnectedIncarnation,
				finalize: () => {
					runtime.removeUserIfSessionMatches(7, disconnectedIncarnation);
				},
				ttlMs: 15,
			});

			runtime.removeUser(7);
			runtime.addUser(7, { micMuted: true, soundMuted: false });
			const successorIncarnation = runtime.getVoiceSessionIncarnation(7);

			testScheduler.advanceBy(15);

			expect(runtime.getUser(7)).toBeDefined();
			expect(runtime.getVoiceSessionIncarnation(7)).toBe(successorIncarnation);
		} finally {
			await runtime.destroy();
		}
	});
});
