import { describe, expect, it } from 'bun:test';
import type { TDesktopPushKeybindEvent } from '@/runtime/types';
import { createPushMicKeybindController, mountPushMicKeybindController } from '../push-mic-keybind-controller';

// `store` is the live own voice state: setMicMuted, the mic button and the deafen button write it
// synchronously. `committed` is the copy the React hook last committed; it lags the store until
// commit(). The controller must take mute and deafen state from the store, never from `committed`.
const createHarness = (initial: { micMuted: boolean; soundMuted?: boolean; pushReleaseDelayMs?: number }) => {
	const store = { micMuted: initial.micMuted, soundMuted: initial.soundMuted ?? false };
	const requested: boolean[] = [];
	const timers = new Map<number, () => void>();
	let nextTimerId = 0;
	let deliver: (event: TDesktopPushKeybindEvent) => void = () => {
		throw new Error('Controller is not subscribed');
	};
	const committed = {
		pushToTalkKeybind: 'Control+KeyT',
		pushToMuteKeybind: 'Control+KeyM',
		currentVoiceChannelId: 1,
		canSpeak: true,
		pushReleaseDelayMs: initial.pushReleaseDelayMs ?? 20,
		micMuted: store.micMuted,
		soundMuted: store.soundMuted,
		// Same guards as setMicMuted in use-voice-controls.ts: no-op when already in that state,
		// and no unmute while deafened.
		setMicMuted: (micMuted: boolean): Promise<void> => {
			requested.push(micMuted);
			if (micMuted !== store.micMuted && !(store.soundMuted && !micMuted)) {
				store.micMuted = micMuted;
			}
			return Promise.resolve();
		},
	};
	const controller = createPushMicKeybindController({
		getInputs: () => committed,
		getOwnVoiceState: () => store,
		getDesktopBridge: () => ({
			setGlobalPushKeybinds: () => Promise.resolve({ talkRegistered: true, muteRegistered: true, errors: [] }),
			subscribeGlobalPushKeybindEvents: (callback) => {
				deliver = callback;
				return () => {};
			},
		}),
		setTimeout: (callback) => {
			nextTimerId += 1;
			timers.set(nextTimerId, callback);
			return nextTimerId;
		},
		clearTimeout: (handle) => {
			timers.delete(handle);
		},
		log: () => {},
		warn: () => {},
	});
	mountPushMicKeybindController(controller, committed);
	const commit = (): void => {
		committed.micMuted = store.micMuted;
		committed.soundMuted = store.soundMuted;
	};
	const press = (kind: TDesktopPushKeybindEvent['kind']): void => deliver({ kind, active: true });
	// Zero delay delivers key-up directly. For positive delay, manually complete its timer.
	// A following press without commit() forces the stale ordering; it does not establish
	// that Electron delivers timer completion and key-down without a React checkpoint.
	const release = (kind: TDesktopPushKeybindEvent['kind']): void => {
		deliver({ kind, active: false });
		const pending = [...timers.values()];
		timers.clear();
		for (const callback of pending) callback();
	};
	return { store, requested, commit, press, release };
};

describe('push mic keybinds read live voice state, not the committed copy', () => {
	for (const pushReleaseDelayMs of [0, 20]) {
		it(`push-to-mute still unmutes on re-press before commit (${pushReleaseDelayMs} ms release)`, () => {
			const h = createHarness({ micMuted: false, pushReleaseDelayMs });
			h.press('mute');
			h.commit();
			expect(h.store.micMuted).toBe(true);
			h.release('mute');
			expect(h.store.micMuted).toBe(false);
			// No commit: the committed copy still says "muted".
			h.press('mute');
			expect(h.store.micMuted).toBe(true);
			h.release('mute');
			// ★ Before this fix the second press captured the stale "muted" as its baseline, so this was true.
			expect(h.store.micMuted).toBe(false);

			// Without another voice-state change, later taps before this fix kept the wrong baseline.
			h.commit();
			h.press('mute');
			h.commit();
			h.release('mute');
			h.commit();
			expect(h.store.micMuted).toBe(false);
		});

		it(`push-to-talk still mutes on re-press before commit (${pushReleaseDelayMs} ms release)`, () => {
			const h = createHarness({ micMuted: true, pushReleaseDelayMs });
			h.press('talk');
			h.commit();
			expect(h.store.micMuted).toBe(false);
			h.release('talk');
			expect(h.store.micMuted).toBe(true);
			h.press('talk');
			expect(h.store.micMuted).toBe(false);
			h.release('talk');
			// ★ Before this fix the stale "unmuted" baseline left the mic open after the key is released.
			expect(h.store.micMuted).toBe(true);
		});
	}

	it('push-to-mute returns to a mic-button unmute that React has not committed yet', () => {
		const h = createHarness({ micMuted: true });
		// The mic button writes the store directly.
		h.store.micMuted = false;
		h.press('mute');
		expect(h.store.micMuted).toBe(true);
		h.release('mute');
		// ★ Before this fix the baseline was the stale "muted" from before the click.
		expect(h.store.micMuted).toBe(false);
	});

	it('push-to-talk opens the mic right after an undeafen that React has not committed yet', () => {
		const h = createHarness({ micMuted: true, soundMuted: true });
		// The deafen button writes the store directly; this user was muted before deafening.
		h.store.soundMuted = false;
		h.press('talk');
		// ★ Before this fix the stale "deafened" forced the target to muted, so the held key did nothing.
		expect(h.store.micMuted).toBe(false);
		h.release('talk');
		expect(h.store.micMuted).toBe(true);
	});

	it('never asks to unmute right after a deafen that React has not committed yet', () => {
		const h = createHarness({ micMuted: false });
		h.store.soundMuted = true;
		h.store.micMuted = true;
		h.press('talk');
		h.release('talk');
		// Before this fix this was [false, false]; only the deafen guard inside setMicMuted stops it.
		expect(h.requested).toEqual([true, true]);
		expect(h.store.micMuted).toBe(true);
	});

	for (const kind of ['mute', 'talk'] as const) {
		const baseline = kind === 'talk';

		it(`a ${kind} tap with a commit after every step returns to the starting state`, () => {
			const h = createHarness({ micMuted: baseline });
			for (let tap = 0; tap < 3; tap += 1) {
				h.press(kind);
				h.commit();
				expect(h.store.micMuted).toBe(!baseline);
				h.release(kind);
				h.commit();
				expect(h.store.micMuted).toBe(baseline);
			}
			expect(h.requested).toEqual([!baseline, baseline, !baseline, baseline, !baseline, baseline]);
		});

		it(`a ${kind} hold keeps its target across commits and repeated key-downs, then restores`, () => {
			const h = createHarness({ micMuted: baseline });
			h.press(kind);
			h.commit();
			h.press(kind);
			h.commit();
			expect(h.store.micMuted).toBe(!baseline);
			h.release(kind);
			expect(h.store.micMuted).toBe(baseline);
		});
	}

	it('a push-to-mute tap leaves a deliberately muted mic muted', () => {
		const h = createHarness({ micMuted: true });
		h.press('mute');
		h.release('mute');
		expect(h.store.micMuted).toBe(true);
		expect(h.requested).toEqual([true, true]);
	});
});
