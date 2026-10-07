import { describe, expect, it } from 'bun:test';
import {
	clearHeldPushMicState,
	resolveHeldPushMicTarget,
	resolveMicOperationFailurePolicy,
	resolvePushMicState,
	type TPushMicState,
	updatePushMicStateForKeyEvent,
} from '../push-mic-state';

const idlePushMicState = (): TPushMicState => ({
	isPushToTalkHeld: false,
	isPushToMuteHeld: false,
	micMutedBeforePush: undefined,
});

describe('push mic state', () => {
	it('keeps the mic muted while deafened even when push-to-talk is held', () => {
		const state = updatePushMicStateForKeyEvent(idlePushMicState(), { kind: 'talk', active: true }, true);

		expect(resolvePushMicState(state, true)).toEqual({
			targetMicMuted: true,
			shouldClearMicMutedBeforePush: false,
		});
	});

	it('lets push-to-mute override push-to-talk when both are held', () => {
		const talkState = updatePushMicStateForKeyEvent(idlePushMicState(), { kind: 'talk', active: true }, true);
		const bothHeldState = updatePushMicStateForKeyEvent(talkState, { kind: 'mute', active: true }, false);

		expect(resolvePushMicState(bothHeldState, false)).toEqual({
			targetMicMuted: true,
			shouldClearMicMutedBeforePush: false,
		});
	});

	it('temporarily unmutes a muted mic for push-to-talk and restores on release', () => {
		const heldState = updatePushMicStateForKeyEvent(idlePushMicState(), { kind: 'talk', active: true }, true);

		expect(resolvePushMicState(heldState, false)).toEqual({
			targetMicMuted: false,
			shouldClearMicMutedBeforePush: false,
		});

		const releasedState = updatePushMicStateForKeyEvent(heldState, { kind: 'talk', active: false }, false);

		expect(resolvePushMicState(releasedState, false)).toEqual({
			targetMicMuted: true,
			shouldClearMicMutedBeforePush: true,
		});
	});

	it('temporarily mutes an unmuted mic for push-to-mute and restores on release', () => {
		const heldState = updatePushMicStateForKeyEvent(idlePushMicState(), { kind: 'mute', active: true }, false);

		expect(resolvePushMicState(heldState, false)).toEqual({
			targetMicMuted: true,
			shouldClearMicMutedBeforePush: false,
		});

		const releasedState = updatePushMicStateForKeyEvent(heldState, { kind: 'mute', active: false }, true);

		expect(resolvePushMicState(releasedState, false)).toEqual({
			targetMicMuted: false,
			shouldClearMicMutedBeforePush: true,
		});
	});

	it('clears held push keys without dropping the restore baseline', () => {
		const heldState = updatePushMicStateForKeyEvent(idlePushMicState(), { kind: 'talk', active: true }, true);
		const clearedState = clearHeldPushMicState(heldState);

		expect(clearedState).toEqual({
			isPushToTalkHeld: false,
			isPushToMuteHeld: false,
			micMutedBeforePush: true,
		});
		expect(resolvePushMicState(clearedState, false)).toEqual({
			targetMicMuted: true,
			shouldClearMicMutedBeforePush: true,
		});
	});

	it('has no target when no push override is active or pending restore', () => {
		expect(resolvePushMicState(idlePushMicState(), false)).toEqual({
			targetMicMuted: undefined,
			shouldClearMicMutedBeforePush: false,
		});
	});

	// resolvePushMicState and the confirmed-state reconciliation effect use this to
	// know which mute state a currently held push key demands.
	describe('resolveHeldPushMicTarget', () => {
		it('demands muted while push-to-mute is held', () => {
			expect(
				resolveHeldPushMicTarget({ isPushToTalkHeld: false, isPushToMuteHeld: true, micMutedBeforePush: false }),
			).toBe(true);
		});

		it('demands unmuted while push-to-talk is held', () => {
			expect(
				resolveHeldPushMicTarget({ isPushToTalkHeld: true, isPushToMuteHeld: false, micMutedBeforePush: true }),
			).toBe(false);
		});

		it('prefers muted when both keys are held', () => {
			expect(
				resolveHeldPushMicTarget({ isPushToTalkHeld: true, isPushToMuteHeld: true, micMutedBeforePush: false }),
			).toBe(true);
		});

		it('has no held target when neither key is down', () => {
			expect(resolveHeldPushMicTarget(idlePushMicState())).toBeUndefined();
		});
	});

	// setMicMuted consults this in its catch: a current microphone-state failure
	// fails closed to muted (and resyncs that safe state), while a stale operation
	// is ignored so it cannot clobber a newer in-flight user intent.
	describe('resolveMicOperationFailurePolicy', () => {
		it('fails closed to muted when the operation is still current', () => {
			expect(resolveMicOperationFailurePolicy(true)).toEqual({
				shouldFailClosed: true,
				micMuted: true,
			});
		});

		it('ignores the failure when the operation has been superseded', () => {
			expect(resolveMicOperationFailurePolicy(false)).toEqual({
				shouldFailClosed: false,
			});
		});
	});
});
