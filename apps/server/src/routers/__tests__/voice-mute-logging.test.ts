import { afterEach, expect, spyOn, test } from 'bun:test';
import { ChannelPermission } from '@sharkord/shared';
import { initTest } from '../../__tests__/helpers';
import { logger } from '../../logger';
import { VoiceRuntime } from '../../runtimes/voice';
import { createVoiceRestoreOrJoinService } from '../voice/restore-or-join-service';

afterEach(async () => {
	const runtime = VoiceRuntime.findById(2);
	if (runtime) {
		for (const user of [...runtime.getState().users]) runtime.removeUser(user.userId);
		await runtime.destroy();
	}
});

const setup = async () => {
	const runtime = new VoiceRuntime(2);
	await runtime.init();
	const { caller } = await initTest(2);
	return { runtime, caller };
};

test('join initializes mute state; updates log applied and stale decisions but not webcam-only updates', async () => {
	const { runtime, caller } = await setup();
	const log = spyOn(logger, 'info');
	try {
		await caller.voice.join({ channelId: 2, state: { micMuted: false, soundMuted: true } });
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Voice mute state initialized',
				callSite: 'join',
				userId: 2,
				channelId: 2,
				micMuted: false,
				soundMuted: true,
			}),
		);
		log.mockClear();
		await caller.voice.updateState({ micMuted: true, seq: 10 });
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Voice mute state applied',
				callSite: 'updateState',
				userId: 2,
				channelId: 2,
				previousMicMuted: false,
				micMuted: true,
				previousSoundMuted: true,
				soundMuted: true,
				seq: 10,
			}),
		);
		log.mockClear();
		await caller.voice.updateState({ micMuted: false, soundMuted: false, seq: 9 });
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Voice mute update dropped as stale',
				seq: 9,
				lastAppliedSeq: 10,
				requestedMicMuted: false,
				requestedSoundMuted: false,
			}),
		);
		expect(runtime.getUserState(2)).toMatchObject({ micMuted: true, soundMuted: true });
		log.mockClear();
		await caller.voice.updateState({ webcamEnabled: true, seq: 11 });
		expect(log).not.toHaveBeenCalled();
	} finally {
		log.mockRestore();
	}
});

test('no-SPEAK update logs the stripped mute request without applying it', async () => {
	const { runtime, caller } = await setup();
	const { caller: owner } = await initTest(1);
	await owner.channels.updatePermissions({
		channelId: 2,
		userId: 2,
		permissions: [ChannelPermission.VIEW_CHANNEL, ChannelPermission.JOIN],
	});
	await owner.channels.update({ channelId: 2, private: true });
	await caller.voice.join({ channelId: 2, state: { micMuted: true, soundMuted: false } });
	const log = spyOn(logger, 'info');
	try {
		await caller.voice.updateState({ micMuted: false, seq: 1 });
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Voice mute update stripped by permission',
				callSite: 'updateState',
				userId: 2,
				channelId: 2,
				requestedMicMuted: false,
				seq: 1,
			}),
		);
		expect(runtime.getUserState(2).micMuted).toBe(true);
	} finally {
		log.mockRestore();
	}
});

for (const failBootstrap of [false, true]) {
	test(`existing restore logs reconciliation before bootstrap (failure=${failBootstrap})`, async () => {
		const { runtime } = await setup();
		runtime.addUser(2, { micMuted: false, soundMuted: false });
		const log = spyOn(logger, 'info');
		try {
			const restore = makeRestore(runtime, failBootstrap);
			const result = restore();
			if (failBootstrap) await expect(result).rejects.toThrow('bootstrap failed');
			else await result;
			expect(log).toHaveBeenCalledWith(
				expect.objectContaining({
					message: 'Voice mute state reconciled',
					callSite: 'restore',
					userId: 2,
					channelId: 2,
					clientInstanceId: 'client-a',
					reconnectAttemptId: 'attempt-a',
					previousMicMuted: false,
					micMuted: true,
					previousSoundMuted: false,
					soundMuted: true,
				}),
			);
			expect(runtime.getUserState(2)).toMatchObject({ micMuted: true, soundMuted: true });
		} finally {
			log.mockRestore();
		}
	});
}

test('fresh restore logs initialized state', async () => {
	const { runtime } = await setup();
	const log = spyOn(logger, 'info');
	try {
		await makeRestore(runtime, false)();
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Voice mute state initialized',
				callSite: 'restore-fresh',
				userId: 2,
				channelId: 2,
				micMuted: true,
				soundMuted: true,
				reconnectAttemptId: 'attempt-a',
			}),
		);
	} finally {
		log.mockRestore();
	}
});

const makeRestore = (runtime: VoiceRuntime, failBootstrap: boolean) => {
	const connection = { identity: {}, clientInstanceId: 'client-a' };
	const service = createVoiceRestoreOrJoinService({
		findRuntimeByChannelId: () => runtime,
		findRuntimeByUserId: (userId) => (runtime.getUser(userId) ? runtime : undefined),
		getPendingVoiceChannelIdsOwnedElsewhere: () => [],
		consumeReconnectLabBehavior: () => undefined,
		delay: async () => {},
		prepareBootstrap: async () => {
			if (failBootstrap) throw new Error('bootstrap failed');
			return { assertCommittable: () => {}, commit: () => {}, dispose: () => {}, buildCommittedResponse: () => ({}) };
		},
		logRestoreEvent: () => {},
		logJoined: () => {},
	});
	return () =>
		service.restoreOrJoin({
			channelId: 2,
			state: { micMuted: true, soundMuted: true },
			reconnectAttemptId: 'attempt-a',
			user: { id: 2, name: 'Test' },
			context: {
				resolveTarget: async () => ({ channel: { id: 2, name: 'Voice' }, runtime }),
				getClientInstanceId: () => 'client-a',
				getOwnConnection: () => connection,
				getUserConnections: () => [connection],
				closeOwnConnection: () => {},
				bindVoiceSession: () => {},
				publishPresence: () => {},
			},
		});
};
