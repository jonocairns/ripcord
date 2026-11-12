import { describe, expect, it } from 'bun:test';
import { resolveOwnVoiceState, type TOwnPushHold } from '@/features/server/voice/own-voice-state';
import type {
	TDesktopPushKeybindEvent,
	TDesktopPushKeybindsInput,
	TGlobalPushKeybindRegistrationResult,
} from '@/runtime/types';
import {
	createPushMicKeybindController,
	mountPushMicKeybindController,
	type TPushMicKeybindControllerPorts,
	type TPushMicKeybindInputs,
} from '../push-mic-keybind-controller';

const createScheduler = () => {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { due: number; callback: () => void }>();
	return {
		setTimeout: (callback: () => void, milliseconds: number): number => {
			const id = ++nextId;
			timers.set(id, { due: now + milliseconds, callback });
			return id;
		},
		clearTimeout: (id: number): void => {
			timers.delete(id);
		},
		advance: (milliseconds: number): void => {
			const target = now + milliseconds;
			while (true) {
				const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
				if (!next || next[1].due > target) break;
				const [id, timer] = next;
				now = timer.due;
				timers.delete(id);
				timer.callback();
			}
			now = target;
		},
		pendingCallbacks: (): Array<() => void> => [...timers.values()].map((timer) => timer.callback),
		pendingCount: (): number => timers.size,
	};
};

const createDeferred = <T>() => {
	let resolve: (value: T) => void = () => {
		throw new Error('Deferred promise not initialized');
	};
	let reject: (error: unknown) => void = () => {
		throw new Error('Deferred promise not initialized');
	};
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
};

const successfulRegistration = (): TGlobalPushKeybindRegistrationResult => ({
	talkRegistered: true,
	muteRegistered: true,
	errors: [],
});

const createHarness = (options: { micMuted?: boolean; desktop?: boolean } = {}) => {
	const scheduler = createScheduler();
	let hold: TOwnPushHold = { talk: false, mute: false };
	const holdCalls: TOwnPushHold[] = [];
	const restingMicMuted = options.micMuted ?? true;
	const muteCalls: Array<{ micMuted: boolean; playSound: false }> = [];
	const registrations: TDesktopPushKeybindsInput[] = [];
	const subscriptions: Array<{ callback: (event: TDesktopPushKeybindEvent) => void; removed: boolean }> = [];
	const warnings: string[] = [];
	const logs: Array<{ message: string; context: object }> = [];
	const registrationResults: Array<Promise<TGlobalPushKeybindRegistrationResult>> = [];
	const inputs: TPushMicKeybindInputs & { micMuted: boolean; soundMuted: boolean } = {
		pushToTalkKeybind: 'Control+KeyT',
		pushToMuteKeybind: 'Control+KeyM',
		currentVoiceChannelId: 1,
		canSpeak: true,
		micMuted: options.micMuted ?? true,
		soundMuted: false,
		pushReleaseDelayMs: 100,
		ensureMicStarted: async () => {},
	};
	const bridge: NonNullable<ReturnType<TPushMicKeybindControllerPorts['getDesktopBridge']>> = {
		setGlobalPushKeybinds: (keybinds) => {
			registrations.push(keybinds);
			return registrationResults.shift() ?? Promise.resolve(successfulRegistration());
		},
		subscribeGlobalPushKeybindEvents: (callback) => {
			const subscription = { callback, removed: false };
			subscriptions.push(subscription);
			return () => {
				subscription.removed = true;
			};
		},
	};
	let bridgeReads = 0;
	const controller = createPushMicKeybindController({
		getInputs: () => inputs,
		getHold: () => hold,
		setHold: (next) => {
			hold = next;
			holdCalls.push(next);
			const micMuted = resolveOwnVoiceState({
				intent: { micMuted: restingMicMuted, soundMuted: inputs.soundMuted },
				pushHold: hold,
				micTestActive: false,
			}).micMuted;
			muteCalls.push({ micMuted, playSound: false });
			inputs.micMuted = micMuted;
		},
		getDesktopBridge: () => {
			bridgeReads += 1;
			return options.desktop === false ? undefined : bridge;
		},
		setTimeout: scheduler.setTimeout,
		clearTimeout: scheduler.clearTimeout,
		log: (message, context) => logs.push({ message, context }),
		warn: (message) => warnings.push(message),
	});
	return {
		controller,
		inputs,
		scheduler,
		holdCalls,
		muteCalls,
		registrations,
		subscriptions,
		registrationResults,
		warnings,
		logs,
		bridgeReads: () => bridgeReads,
		mutedValues: () => muteCalls.map((call) => call.micMuted),
		emit: (kind: TDesktopPushKeybindEvent['kind'], active: boolean): void => {
			for (const subscription of subscriptions) {
				if (!subscription.removed) subscription.callback({ kind, active });
			}
		},
	};
};

describe('push mic keybind controller', () => {
	for (const firstReleased of ['talk', 'mute'] as const) {
		it(`keeps overlapping releases independent when ${firstReleased} releases first`, () => {
			const h = createHarness();
			const cleanup = mountPushMicKeybindController(h.controller, h.inputs);
			h.emit('talk', true);
			h.emit('mute', true);
			h.emit(firstReleased, false);
			h.scheduler.advance(25);
			h.emit(firstReleased === 'talk' ? 'mute' : 'talk', false);
			expect(h.scheduler.pendingCount()).toBe(2);
			expect(h.mutedValues()).toEqual([false, true]);

			h.scheduler.advance(75);
			expect(h.scheduler.pendingCount()).toBe(1);
			expect(h.inputs.micMuted).toBe(firstReleased === 'talk');
			h.scheduler.advance(25);
			expect(h.mutedValues()).toEqual([false, true, firstReleased === 'talk', true]);
			expect(h.scheduler.pendingCount()).toBe(0);
			cleanup();
		});
	}

	for (const kind of ['talk', 'mute'] as const) {
		it(`keeps ${kind} held when re-pressed during a pending release`, () => {
			const baseline = kind === 'talk';
			const h = createHarness({ micMuted: baseline });
			const cleanup = mountPushMicKeybindController(h.controller, h.inputs);
			h.emit(kind, true);
			h.emit(kind, false);
			const cancelledCallbacks = h.scheduler.pendingCallbacks();
			h.scheduler.advance(50);
			h.emit(kind, true);
			expect(h.scheduler.pendingCount()).toBe(0);
			for (const callback of cancelledCallbacks) callback();
			h.scheduler.advance(100);
			expect(h.mutedValues()).toEqual([!baseline, !baseline]);

			h.emit(kind, false);
			// A stale callback must not clear this key's replacement timer.
			for (const callback of cancelledCallbacks) callback();
			expect(h.scheduler.pendingCount()).toBe(1);
			h.scheduler.advance(100);
			expect(h.mutedValues()).toEqual([!baseline, !baseline, baseline]);
			cleanup();
		});

		for (const loss of ['permission', 'channel'] as const) {
			for (const pendingRelease of [false, true]) {
				it(`restores ${kind} on ${loss} loss with a ${pendingRelease ? 'pending release' : 'held key'}`, () => {
					const baseline = kind === 'talk';
					const h = createHarness({ micMuted: baseline });
					const cleanup = mountPushMicKeybindController(h.controller, h.inputs);
					h.emit(kind, true);
					if (pendingRelease) h.emit(kind, false);
					const cancelledCallbacks = h.scheduler.pendingCallbacks();
					if (loss === 'permission') h.inputs.canSpeak = false;
					else h.inputs.currentVoiceChannelId = undefined;
					h.controller.reconcileChannelPermission(h.inputs.currentVoiceChannelId, h.inputs.canSpeak);
					expect(h.mutedValues()).toEqual([!baseline, baseline]);
					expect(h.scheduler.pendingCount()).toBe(0);
					h.emit(kind, true);
					for (const callback of cancelledCallbacks) callback();
					h.scheduler.advance(100);
					expect(h.mutedValues()).toEqual([!baseline, baseline]);

					h.inputs.canSpeak = true;
					h.inputs.currentVoiceChannelId = 2;
					h.emit(kind, false);
					h.scheduler.advance(100);
					h.emit(kind, true);
					h.emit(kind, false);
					h.scheduler.advance(100);
					expect(h.inputs.micMuted).toBe(baseline);
					cleanup();
				});
			}
		}

		it(`restores ${kind} on cleanup and ignores old events and timers during lifecycle replay`, () => {
			const baseline = kind === 'talk';
			const h = createHarness({ micMuted: baseline });
			const cleanup = mountPushMicKeybindController(h.controller, h.inputs);
			h.emit(kind, true);
			h.emit(kind, false);
			const oldCallbacks = h.scheduler.pendingCallbacks();
			cleanup();
			cleanup();
			expect(h.mutedValues()).toEqual([!baseline, baseline]);
			expect(h.scheduler.pendingCount()).toBe(0);
			expect(h.subscriptions.every((subscription) => subscription.removed)).toBe(true);
			expect(h.registrations).toEqual([{ pushToTalkKeybind: 'Control+KeyT', pushToMuteKeybind: 'Control+KeyM' }, {}]);
			for (const subscription of h.subscriptions) subscription.callback({ kind, active: true });
			for (const callback of oldCallbacks) callback();
			expect(h.mutedValues()).toEqual([!baseline, baseline]);

			const replayCleanup = mountPushMicKeybindController(h.controller, h.inputs);
			h.emit(kind, true);
			h.emit(kind, false);
			for (const callback of oldCallbacks) callback();
			cleanup();
			expect(h.scheduler.pendingCount()).toBe(1);
			h.scheduler.advance(100);
			expect(h.mutedValues()).toEqual([!baseline, baseline, !baseline, baseline]);
			expect(h.muteCalls.every((call) => call.playSound === false)).toBe(true);
			replayCleanup();
		});
	}

	it('restores the baseline on lifecycle cleanup while both keys are held', () => {
		const h = createHarness({ micMuted: false });
		const cleanup = mountPushMicKeybindController(h.controller, h.inputs);
		h.emit('talk', true);
		h.emit('mute', true);
		cleanup();
		expect(h.mutedValues()).toEqual([false, true, false]);
		expect(h.subscriptions.every((subscription) => subscription.removed)).toBe(true);
		expect(h.scheduler.pendingCount()).toBe(0);
	});

	it('clears both held keys and pending releases if the channel is lost before a timer fires', () => {
		const h = createHarness({ micMuted: false });
		const cleanup = mountPushMicKeybindController(h.controller, h.inputs);
		h.emit('talk', true);
		h.emit('mute', true);
		h.emit('talk', false);
		h.emit('mute', false);
		h.inputs.currentVoiceChannelId = undefined;
		h.scheduler.advance(100);
		expect(h.mutedValues()).toEqual([false, true, false]);
		expect(h.scheduler.pendingCount()).toBe(0);
		cleanup();
	});

	it('clears held keys when an event arrives after permission loss before reconciliation', () => {
		const h = createHarness();
		const cleanup = mountPushMicKeybindController(h.controller, h.inputs);
		h.emit('talk', true);
		h.emit('talk', false);
		h.inputs.canSpeak = false;
		h.emit('mute', true);
		expect(h.mutedValues()).toEqual([false, true]);
		expect(h.scheduler.pendingCount()).toBe(0);
		cleanup();
	});

	it('requires a fresh press after cancellation and retains current release timing', () => {
		const h = createHarness();
		const cleanup = mountPushMicKeybindController(h.controller, h.inputs);
		h.emit('talk', true);
		h.controller.reconcileChannelPermission(undefined, true);
		h.emit('talk', true);
		expect(h.holdCalls).toHaveLength(2);
		h.emit('talk', false);
		h.inputs.pushReleaseDelayMs = 250;
		h.emit('talk', true);
		expect(h.holdCalls.at(-1)).toEqual({ talk: true, mute: false });
		cleanup();
	});

	it('restores held keys during registration replacement and fences callbacks from the previous mount', () => {
		const h = createHarness();
		const oldCleanup = mountPushMicKeybindController(h.controller, h.inputs);
		h.emit('talk', true);
		h.emit('mute', true);
		h.emit('talk', false);
		h.emit('mute', false);
		const oldTimers = h.scheduler.pendingCallbacks();
		const oldSubscription = h.subscriptions[0];
		if (!oldSubscription) throw new Error('Expected original subscription');
		h.inputs.pushToTalkKeybind = 'Control+KeyN';
		const cleanup = mountPushMicKeybindController(h.controller, h.inputs);
		expect(h.mutedValues()).toEqual([false, true, true]);
		expect(oldSubscription.removed).toBe(true);
		expect(h.registrations).toEqual([
			{ pushToTalkKeybind: 'Control+KeyT', pushToMuteKeybind: 'Control+KeyM' },
			{},
			{ pushToTalkKeybind: 'Control+KeyN', pushToMuteKeybind: 'Control+KeyM' },
		]);
		h.emit('talk', true);
		h.emit('talk', false);
		oldSubscription.callback({ kind: 'mute', active: true });
		for (const callback of oldTimers) callback();
		oldCleanup();
		expect(h.mutedValues()).toEqual([false, true, true, false]);
		expect(h.scheduler.pendingCount()).toBe(1);
		h.scheduler.advance(100);
		expect(h.mutedValues()).toEqual([false, true, true, false, true]);
		cleanup();
	});

	it('does not acquire desktop resources during construction and mounts safely without a desktop bridge', () => {
		const h = createHarness({ desktop: false });
		expect(h.bridgeReads()).toBe(0);
		expect(h.registrations).toEqual([]);
		const cleanup = mountPushMicKeybindController(h.controller, h.inputs);
		cleanup();
		expect(h.subscriptions).toEqual([]);
		expect(h.muteCalls).toEqual([]);
		expect(h.scheduler.pendingCount()).toBe(0);
	});

	for (const completion of ['issues', 'failure'] as const) {
		it(`ignores stale registration ${completion} after replacement and reports current registration issues`, async () => {
			const h = createHarness();
			const oldRegistration = createDeferred<TGlobalPushKeybindRegistrationResult>();
			h.registrationResults.push(oldRegistration.promise);
			const oldCleanup = mountPushMicKeybindController(h.controller, h.inputs);
			const currentRegistration = createDeferred<TGlobalPushKeybindRegistrationResult>();
			h.registrationResults.push(Promise.resolve(successfulRegistration()), currentRegistration.promise);
			const cleanup = mountPushMicKeybindController(h.controller, h.inputs);
			if (completion === 'issues') {
				oldRegistration.resolve({ ...successfulRegistration(), errors: ['Old registration issue'] });
			} else {
				oldRegistration.reject(new Error('Old registration failure'));
			}
			await oldRegistration.promise.catch(() => undefined);
			await Promise.resolve();
			expect(h.warnings).toEqual([]);
			expect(h.logs).toEqual([]);
			currentRegistration.resolve({ ...successfulRegistration(), errors: ['Current issue', 'Second issue'] });
			await currentRegistration.promise;
			expect(h.warnings).toEqual(['Current issue']);
			expect(h.logs.map((log) => log.message)).toEqual(['Global push keybind registration issues']);
			oldCleanup();
			cleanup();
		});
	}
});
