import { describe, expect, it } from 'bun:test';
import {
	clearHeldPushMicState,
	resolvePushMicState,
	updatePushMicStateForKeyEvent,
	type TPushMicState,
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
});
