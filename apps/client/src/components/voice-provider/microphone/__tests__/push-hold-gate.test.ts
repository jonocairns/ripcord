import { beforeEach, expect, it, mock } from 'bun:test';
import { useServerStore } from '@/features/server/slice';
import { resolveOwnVoiceState } from '@/features/server/voice/own-voice-state';
import { ownMicWantedSelector, ownTransmittingSelector } from '@/features/server/voice/selectors';
import type { TDesktopPushKeybindEvent } from '@/runtime/types';
import { createOwnMicControls } from '../../own-mic-controls';
import { createVoiceStateOperations } from '../../voice-state-operation';
import type { TMicrophoneStartOutcome } from '../microphone-pipeline-controller';
import { mountOwnMicGateSync } from '../own-mic-gate-sync';
import { createPushMicKeybindController } from '../push-mic-keybind-controller';

const store = useServerStore.getState;
beforeEach(() => {
	store().resetState();
	useServerStore.setState({ currentVoiceChannelId: 7, ownVoiceIntent: { micMuted: true, soundMuted: false } });
});
const harness = () => {
	const writes = mock((intent: { micMuted?: boolean; soundMuted?: boolean }) => store().setOwnVoiceIntent(intent));
	const operations = createVoiceStateOperations({
		setOwnVoiceIntent: writes,
		cancelPushHold: () => store().setOwnPushHold({ talk: false, mute: false }),
	});
	const results: Promise<TMicrophoneStartOutcome>[] = [];
	const start = mock(() => results.shift() ?? Promise.resolve<TMicrophoneStartOutcome>({ status: 'started' }));
	const reset = mock(() => {});
	let live = false;
	const apply = mock((_muted: boolean) => {});
	const controls = createOwnMicControls({
		getIntent: () => store().ownVoiceIntent,
		isMicWanted: () => ownMicWantedSelector(store()),
		isMicMutedWithoutTest: () =>
			resolveOwnVoiceState({ intent: store().ownVoiceIntent, pushHold: store().ownPushHold, micTestActive: false })
				.micMuted,
		setOwnVoiceIntent: writes,
		cancelPushHold: () => store().setOwnPushHold({ talk: false, mute: false }),
		getCurrentVoiceChannelId: () => store().currentVoiceChannelId,
		hasLiveMicCapture: () => live,
		startMicStream: start,
		resetMicRecoveryBudget: reset,
		beginOperation: operations.begin,
		playSound: () => {},
	});
	let emit: (event: TDesktopPushKeybindEvent) => void = () => {};
	const timers = new Map<number, () => void>();
	let next = 0;
	const controller = createPushMicKeybindController({
		getInputs: () => ({
			currentVoiceChannelId: store().currentVoiceChannelId,
			canSpeak: true,
			pushReleaseDelayMs: 50,
			ensureMicStarted: controls.ensureMicStarted,
		}),
		getHold: () => store().ownPushHold,
		setHold: (hold) => {
			const previous = store().ownPushHold;
			store().setOwnPushHold(hold);
			void controls.ensureMicStarted({
				resetRecoveryBudget: (hold.talk && !previous.talk) || (hold.mute && !previous.mute),
			});
		},
		getDesktopBridge: () => ({
			setGlobalPushKeybinds: async () => ({ talkRegistered: true, muteRegistered: true, errors: [] }),
			subscribeGlobalPushKeybindEvents: (listener) => {
				emit = listener;
				return () => {};
			},
		}),
		setTimeout: (fn) => {
			next += 1;
			timers.set(next, fn);
			return next;
		},
		clearTimeout: (id) => {
			timers.delete(id);
		},
		log: () => {},
		warn: () => {},
	});
	const unmount = controller.mount({});
	const unsubscribe = mountOwnMicGateSync({
		isTransmitting: () => ownTransmittingSelector(store()),
		subscribe: useServerStore.subscribe,
		apply,
	});
	return {
		controls,
		reset,
		setLive: (value: boolean) => {
			live = value;
		},
		operations,
		writes,
		results,
		start,
		apply,
		emit: (kind: 'talk' | 'mute', active: boolean) => emit({ kind, active }),
		release: () => {
			const callbacks = [...timers.values()];
			timers.clear();
			for (const fn of callbacks) fn();
		},
		cleanup: () => {
			unmount();
			unsubscribe();
		},
	};
};
const flush = async () => {
	for (let i = 0; i < 12; i += 1) await Promise.resolve();
};
it('updates the gate synchronously for overlapping keys without intent writes or React commits', () => {
	const h = harness();
	h.emit('talk', true);
	expect(ownTransmittingSelector(store())).toBe(true);
	h.emit('mute', true);
	expect(ownTransmittingSelector(store())).toBe(false);
	h.emit('mute', false);
	h.release();
	expect(ownTransmittingSelector(store())).toBe(true);
	h.emit('talk', false);
	h.release();
	expect(ownTransmittingSelector(store())).toBe(false);
	expect(h.apply.mock.calls).toEqual([[false], [true], [false], [true]]);
	expect(h.writes).not.toHaveBeenCalled();
	h.cleanup();
});
for (const failure of ['terminal output loss', 'recovery exhaustion'])
	it(`${failure} remains fail closed after unrelated state updates`, () => {
		const h = harness();
		h.emit('talk', true);
		h.operations.commitTerminalMicMuted();
		expect(h.apply).toHaveBeenLastCalledWith(true);
		useServerStore.setState({ connected: true });
		expect(ownTransmittingSelector(store())).toBe(false);
		expect(store().ownPushHold.talk).toBe(false);
		h.cleanup();
	});
for (const muted of [false, true])
	it(`button mute during talk cancels override from resting ${muted}`, async () => {
		const h = harness();
		store().setOwnVoiceIntent({ micMuted: muted });
		h.emit('talk', true);
		await h.controls.toggleMic();
		expect(ownTransmittingSelector(store())).toBe(false);
		h.emit('talk', false);
		h.release();
		expect(ownTransmittingSelector(store())).toBe(false);
		h.cleanup();
	});
it('deafen cancels talk, undeafen cannot reuse its old physical press', async () => {
	const h = harness();
	h.emit('talk', true);
	await h.controls.toggleSound();
	await h.controls.toggleSound();
	h.emit('talk', true);
	expect(ownTransmittingSelector(store())).toBe(false);
	h.emit('talk', false);
	h.release();
	h.emit('talk', true);
	expect(ownTransmittingSelector(store())).toBe(true);
	h.cleanup();
});
it('an old start failure cannot cancel a fresh press and current capture is attempted', async () => {
	const h = harness();
	let resolve: (outcome: TMicrophoneStartOutcome) => void = () => {};
	h.results.push(
		new Promise((yes) => {
			resolve = yes;
		}),
	);
	h.emit('talk', true);
	h.emit('talk', false);
	h.release();
	h.emit('talk', true);
	resolve({ status: 'failed', error: new Error('old') });
	await flush();
	expect(store().ownPushHold.talk).toBe(true);
	expect(h.start).toHaveBeenCalledTimes(2);
	h.cleanup();
});

it('fresh talk from absent resets recovery once, repeats and live key events preserve it', async () => {
	const h = harness();
	h.emit('talk', true);
	await Promise.resolve();
	expect(h.reset).toHaveBeenCalledTimes(1);
	expect(h.start).toHaveBeenCalledTimes(1);
	h.emit('talk', true);
	expect(h.reset).toHaveBeenCalledTimes(1);
	expect(h.start).toHaveBeenCalledTimes(1);
	store().setOwnVoiceIntent({ micMuted: false });
	h.emit('talk', false);
	h.release();
	expect(h.reset).toHaveBeenCalledTimes(1);
	h.setLive(true);
	h.emit('talk', false);
	h.release();
	h.emit('talk', true);
	expect(h.reset).toHaveBeenCalledTimes(1);
	h.cleanup();
});

it('terminal mute prevents repeats from rearming but a release and fresh press inside the delay rearms', async () => {
	const h = harness();
	h.emit('talk', true);
	h.operations.commitTerminalMicMuted();
	await flush();
	expect(ownTransmittingSelector(store())).toBe(false);
	h.emit('talk', true);
	await flush();
	expect(h.start).toHaveBeenCalledTimes(1);
	h.emit('talk', false);
	h.emit('talk', true);
	await flush();
	expect(h.start).toHaveBeenCalledTimes(2);
	expect(ownTransmittingSelector(store())).toBe(true);
	h.cleanup();
});
