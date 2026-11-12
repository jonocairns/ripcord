import { beforeEach, expect, it, mock } from 'bun:test';
import { useServerStore } from '@/features/server/slice';
import { resolveOwnVoiceState } from '@/features/server/voice/own-voice-state';
import { ownMicWantedSelector, ownTransmittingSelector } from '@/features/server/voice/selectors';
import type { TMicrophoneStartOutcome } from '../microphone/microphone-pipeline-controller';
import { createOwnMicControls } from '../own-mic-controls';
import { createVoiceStateOperations } from '../voice-state-operation';

const deferred = <T>() => {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
};
const harness = () => {
	let live = false;
	const store = useServerStore.getState;
	const setIntent = mock((intent: { micMuted?: boolean; soundMuted?: boolean }) => store().setOwnVoiceIntent(intent));
	const cancel = mock(() => store().setOwnPushHold({ talk: false, mute: false }));
	const operations = createVoiceStateOperations({ setOwnVoiceIntent: setIntent, cancelPushHold: cancel });
	const starts: Promise<TMicrophoneStartOutcome>[] = [];
	const start = mock(() => starts.shift() ?? Promise.resolve<TMicrophoneStartOutcome>({ status: 'started' }));
	const error = mock((_message: string) => {});
	const reset = mock(() => {});
	const controls = createOwnMicControls({
		getIntent: () => store().ownVoiceIntent,
		isMicWanted: () => ownMicWantedSelector(store()),
		isMicMutedWithoutTest: () =>
			resolveOwnVoiceState({ intent: store().ownVoiceIntent, pushHold: store().ownPushHold, micTestActive: false })
				.micMuted,
		setOwnVoiceIntent: setIntent,
		cancelPushHold: cancel,
		commitMicFailure: operations.commitTerminalMicMuted,
		getCurrentVoiceChannelId: () => store().currentVoiceChannelId,
		captureSession: () => () => true,
		hasLiveMicCapture: () => live,
		startMicStream: start,
		resetMicRecoveryBudget: reset,
		beginOperation: operations.begin,
		isOperationCurrent: operations.isCurrent,
		playSound: () => {},
		showError: error,
	});
	return {
		controls,
		starts,
		start,
		error,
		reset,
		cancel,
		setIntent,
		operations,
		setLive: (value: boolean) => {
			live = value;
		},
	};
};
beforeEach(() => {
	useServerStore.getState().resetState();
	useServerStore.setState({ currentVoiceChannelId: 7, ownVoiceIntent: { micMuted: true, soundMuted: false } });
});
it('starts unmute immediately without any relay dependency, including ended retained capture', async () => {
	const h = harness();
	const result = h.controls.setMicMuted(false);
	expect(h.start).toHaveBeenCalledTimes(1);
	await result;
	expect(h.reset).toHaveBeenCalledTimes(2);
});
it('commits only current failed acquisition and not superseded acquisition', async () => {
	for (const status of ['failed', 'superseded'] as const) {
		const h = harness();
		h.starts.push(Promise.resolve(status === 'failed' ? { status, error: new Error('capture') } : { status }));
		await h.controls.ensureMicStarted();
		expect(h.error).not.toHaveBeenCalled();
		useServerStore.getState().setOwnPushHold({ talk: true, mute: false });
		await h.controls.ensureMicStarted();
	}
	const h = harness();
	h.starts.push(Promise.resolve({ status: 'failed', error: new Error('capture') }));
	useServerStore.getState().setOwnPushHold({ talk: true, mute: false });
	await h.controls.ensureMicStarted();
	expect(h.error).toHaveBeenCalledTimes(1);
	expect(ownTransmittingSelector(useServerStore.getState())).toBe(false);
	expect(useServerStore.getState().ownPushHold.talk).toBe(false);
});
it('shares pending acquisition without adopting its stale failure, then starts current demand once', async () => {
	const h = harness();
	const old = deferred<TMicrophoneStartOutcome>();
	h.starts.push(old.promise);
	useServerStore.getState().setOwnPushHold({ talk: true, mute: false });
	const first = h.controls.ensureMicStarted();
	h.operations.begin();
	const second = h.controls.ensureMicStarted();
	expect(h.start).toHaveBeenCalledTimes(1);
	old.resolve({ status: 'failed', error: new Error('old') });
	await Promise.all([first, second]);
	expect(h.error).not.toHaveBeenCalled();
	expect(h.start).toHaveBeenCalledTimes(2);
	expect(useServerStore.getState().ownPushHold.talk).toBe(true);
});
for (const muted of [false, true])
	it(`mic button cancels held talk with resting intent ${muted}`, async () => {
		const h = harness();
		useServerStore.getState().setOwnVoiceIntent({ micMuted: muted });
		useServerStore.getState().setOwnPushHold({ talk: true, mute: false });
		await h.controls.toggleMic();
		expect(ownTransmittingSelector(useServerStore.getState())).toBe(false);
		expect(useServerStore.getState().ownVoiceIntent.micMuted).toBe(true);
		useServerStore.getState().setOwnPushHold({ talk: false, mute: false });
		expect(ownTransmittingSelector(useServerStore.getState())).toBe(false);
	});
for (const muted of [false, true])
	it(`deafen preserves mic preference ${muted} and undeafen ensures capture`, async () => {
		const h = harness();
		useServerStore.getState().setOwnVoiceIntent({ micMuted: muted });
		await h.controls.toggleSound();
		expect(h.cancel).toHaveBeenCalledTimes(1);
		await h.controls.toggleSound();
		expect(useServerStore.getState().ownVoiceIntent).toEqual({ micMuted: muted, soundMuted: false });
		expect(h.start).toHaveBeenCalledTimes(muted ? 0 : 1);
	});
it('permits intent changes during testing, blocks them during real deafen, and never starts outside a channel', async () => {
	const h = harness();
	useServerStore.getState().setOwnMicTestActive(true);
	useServerStore.setState({ currentVoiceChannelId: undefined });
	await h.controls.setMicMuted(false);
	expect(useServerStore.getState().ownVoiceIntent.micMuted).toBe(false);
	expect(h.start).not.toHaveBeenCalled();
	useServerStore.getState().setOwnVoiceIntent({ soundMuted: true });
	await h.controls.setMicMuted(true);
	expect(useServerStore.getState().ownVoiceIntent.micMuted).toBe(false);
});

it('explicit mute never opens a held push-mute gate', async () => {
	for (const talk of [false, true]) {
		const h = harness();
		useServerStore.getState().setOwnVoiceIntent({ micMuted: false });
		useServerStore.getState().setOwnPushHold({ talk, mute: true });
		const gates: boolean[] = [];
		const unsubscribe = useServerStore.subscribe((state) => gates.push(ownTransmittingSelector(state)));
		await h.controls.setMicMuted(true);
		unsubscribe();
		expect(gates).not.toContain(true);
	}
});
it('a live ensure leaves operation and recovery budget unchanged', async () => {
	const h = harness();
	useServerStore.getState().setOwnVoiceIntent({ micMuted: false });
	h.setLive(true);
	const token = h.operations.capture();
	await h.controls.ensureMicStarted();
	expect(h.operations.isCurrent(token)).toBe(true);
	expect(h.reset).not.toHaveBeenCalled();
});

it('re-evaluates demand once after a superseded start without a waiting caller', async () => {
	const h = harness();
	useServerStore.getState().setOwnPushHold({ talk: true, mute: false });
	h.starts.push(Promise.resolve({ status: 'superseded' }));
	await h.controls.ensureMicStarted();
	expect(h.start).toHaveBeenCalledTimes(2);
	expect(h.error).not.toHaveBeenCalled();
});
