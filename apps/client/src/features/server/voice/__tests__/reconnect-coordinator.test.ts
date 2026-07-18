import { beforeEach, describe, expect, it } from 'bun:test';
import { useServerStore } from '../../slice';
import {
	captureVoiceReconnectIntentForCurrentSession,
	clearVoiceReconnectRecovery,
	ensureVoiceReconnectStarted,
	getValidPendingVoiceReconnect,
	isVoiceReconnectPeerSuppressed,
	markVoiceReconnectSessionAuthenticated,
	markVoiceReconnectSessionUnauthenticated,
	resolveVoiceRecoveryAction,
	snapshotVoiceReconnectIntent,
	type TPendingVoiceReconnect,
	type TVoiceReconnectSuppression,
	updateVoiceReconnectIntentState,
	VOICE_RECONNECT_INTENT_TTL_MS,
} from '../reconnect-coordinator';
import {
	selectPendingVoiceReconnect,
	selectReconnectAuthenticated,
	selectReconnectingSince,
	selectVoiceReconnectSuppression,
} from '../voice-session-machine';
import {
	dispatchVoiceSession,
	registerVoiceSessionCommandRunner,
	resetVoiceSessionState,
	selectVoiceSessionState,
} from '../voice-session-store';

const getPendingVoiceReconnect = (): TPendingVoiceReconnect | undefined =>
	selectVoiceSessionState(selectPendingVoiceReconnect);
const getReconnectingSince = (): number | undefined => selectVoiceSessionState(selectReconnectingSince);
const getReconnectAuthenticated = (): boolean => selectVoiceSessionState(selectReconnectAuthenticated);
const getVoiceReconnectSuppression = (): TVoiceReconnectSuppression | undefined =>
	selectVoiceSessionState(selectVoiceReconnectSuppression);

describe('voice reconnect coordinator', () => {
	beforeEach(() => {
		useServerStore.getState().resetState();
		resetVoiceSessionState();
	});

	describe('snapshotVoiceReconnectIntent', () => {
		it('stores intent with correct channelId, mute state, and peerUserIds', () => {
			useServerStore.setState({
				ownUserId: 1,
				currentVoiceChannelId: 5,
				ownVoiceDefaults: {
					micMuted: true,
					soundMuted: false,
					webcamEnabled: false,
					sharingScreen: false,
				},
				voiceMap: {
					5: {
						users: {
							1: { micMuted: true, soundMuted: false, webcamEnabled: false, sharingScreen: false },
							10: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
							20: { micMuted: false, soundMuted: true, webcamEnabled: false, sharingScreen: false },
						},
					},
				},
			});

			const expiresAt = Date.now() + VOICE_RECONNECT_INTENT_TTL_MS;
			snapshotVoiceReconnectIntent({ expiresAt });

			const pendingVoiceReconnect = getPendingVoiceReconnect();

			expect(pendingVoiceReconnect).toBeDefined();
			if (!pendingVoiceReconnect) return;
			expect(pendingVoiceReconnect.channelId).toBe(5);
			expect(pendingVoiceReconnect.micMuted).toBe(true);
			expect(pendingVoiceReconnect.soundMuted).toBe(false);
			expect(pendingVoiceReconnect.peerUserIds).toEqual([10, 20]);
			expect(pendingVoiceReconnect.expiresAt).toBe(expiresAt);
			expect(getReconnectingSince()).toBeUndefined();
		});

		it('copies peerUserIds by value so later voiceMap mutations do not affect the snapshot', () => {
			useServerStore.setState({
				ownUserId: 1,
				currentVoiceChannelId: 5,
				ownVoiceDefaults: {
					micMuted: false,
					soundMuted: false,
					webcamEnabled: false,
					sharingScreen: false,
				},
				voiceMap: {
					5: {
						users: {
							1: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
							10: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
							20: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
						},
					},
				},
			});

			snapshotVoiceReconnectIntent({ expiresAt: Date.now() + VOICE_RECONNECT_INTENT_TTL_MS });

			// Mutate the voiceMap after snapshot
			useServerStore.getState().addUserToVoiceChannel({
				channelId: 5,
				userId: 30,
				state: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
			});

			const pendingVoiceReconnect = getPendingVoiceReconnect();

			expect(pendingVoiceReconnect).toBeDefined();
			if (!pendingVoiceReconnect) return;
			expect(pendingVoiceReconnect.peerUserIds).toEqual([10, 20]);
		});

		it('no-ops when currentVoiceChannelId is undefined', () => {
			useServerStore.setState({
				ownUserId: 1,
				currentVoiceChannelId: undefined,
			});

			snapshotVoiceReconnectIntent({ expiresAt: Date.now() + VOICE_RECONNECT_INTENT_TTL_MS });

			expect(getPendingVoiceReconnect()).toBeUndefined();
		});

		it('no-ops when ownUserId is undefined', () => {
			useServerStore.setState({
				ownUserId: undefined,
				currentVoiceChannelId: 5,
			});

			snapshotVoiceReconnectIntent({ expiresAt: Date.now() + VOICE_RECONNECT_INTENT_TTL_MS });

			expect(getPendingVoiceReconnect()).toBeUndefined();
		});
	});

	describe('captureVoiceReconnectIntentForCurrentSession', () => {
		it('captures reconnect intent with the default TTL for the active session', () => {
			useServerStore.setState({
				ownUserId: 1,
				currentVoiceChannelId: 5,
				ownVoiceDefaults: {
					micMuted: true,
					soundMuted: false,
					webcamEnabled: false,
					sharingScreen: false,
				},
				voiceMap: {
					5: {
						users: {
							10: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
						},
					},
				},
			});

			const beforeCapture = Date.now();
			expect(captureVoiceReconnectIntentForCurrentSession()).toBe(true);

			const pendingVoiceReconnect = getPendingVoiceReconnect();

			expect(pendingVoiceReconnect).toBeDefined();
			if (!pendingVoiceReconnect) return;
			expect(pendingVoiceReconnect.channelId).toBe(5);
			expect(pendingVoiceReconnect.micMuted).toBe(true);
			expect(pendingVoiceReconnect.peerUserIds).toEqual([10]);
			expect(pendingVoiceReconnect.expiresAt).toBeGreaterThanOrEqual(beforeCapture + VOICE_RECONNECT_INTENT_TTL_MS);
		});

		it('returns false when no active voice session is available to capture', () => {
			useServerStore.setState({
				ownUserId: 1,
				currentVoiceChannelId: undefined,
			});

			expect(captureVoiceReconnectIntentForCurrentSession()).toBe(false);
			expect(getPendingVoiceReconnect()).toBeUndefined();
		});
	});

	describe('updateVoiceReconnectIntentState', () => {
		it('merges terminal microphone intent into the active reconnect snapshot', () => {
			dispatchVoiceSession({
				type: 'WsDropped',
				pending: {
					channelId: 5,
					micMuted: false,
					soundMuted: false,
					peerUserIds: [10],
					expiresAt: Date.now() + 10_000,
				},
				now: Date.now(),
				online: false,
				authenticated: false,
			});

			expect(updateVoiceReconnectIntentState({ micMuted: true })).toBe(true);
			expect(getPendingVoiceReconnect()).toEqual({
				channelId: 5,
				micMuted: true,
				soundMuted: false,
				peerUserIds: [10],
				expiresAt: expect.any(Number),
			});
		});

		it('does not create reconnect intent outside recovery', () => {
			expect(updateVoiceReconnectIntentState({ micMuted: true })).toBe(false);
			expect(getPendingVoiceReconnect()).toBeUndefined();
		});
	});

	describe('clearVoiceReconnectRecovery', () => {
		it('atomically clears reconnect state', () => {
			dispatchVoiceSession({
				type: 'ReconnectIntentCaptured',
				pending: {
					channelId: 5,
					micMuted: false,
					soundMuted: false,
					peerUserIds: [10],
					expiresAt: Date.now() + VOICE_RECONNECT_INTENT_TTL_MS,
				},
			});
			ensureVoiceReconnectStarted();
			dispatchVoiceSession({
				type: 'ReconnectSuppressionChanged',
				suppression: {
					channelId: 5,
					peerUserIds: [10],
					expiresAt: Date.now() + 10_000,
				},
			});

			clearVoiceReconnectRecovery('user-left-voice');

			expect(getPendingVoiceReconnect()).toBeUndefined();
			expect(getReconnectingSince()).toBeUndefined();
			expect(getVoiceReconnectSuppression()).toBeUndefined();
		});

		it('is idempotent', () => {
			clearVoiceReconnectRecovery('app-teardown');
			clearVoiceReconnectRecovery('app-teardown');

			expect(getPendingVoiceReconnect()).toBeUndefined();
			expect(getReconnectingSince()).toBeUndefined();
			expect(getVoiceReconnectSuppression()).toBeUndefined();
		});
	});

	describe('resolveVoiceRecoveryAction', () => {
		it('returns none when no pending reconnect exists', () => {
			expect(resolveVoiceRecoveryAction()).toEqual({ kind: 'none' });
		});

		it('returns session-present when voiceMap still shows the user in the channel', () => {
			useServerStore.setState({
				ownUserId: 1,
				voiceMap: {
					5: {
						users: {
							1: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
						},
					},
				},
			});

			dispatchVoiceSession({
				type: 'ReconnectIntentCaptured',
				pending: {
					channelId: 5,
					micMuted: false,
					soundMuted: false,
					peerUserIds: [],
					expiresAt: Date.now() + VOICE_RECONNECT_INTENT_TTL_MS,
				},
			});

			expect(resolveVoiceRecoveryAction()).toEqual({ kind: 'session-present', channelId: 5 });
		});

		it('returns session-missing when voiceMap does not show the user', () => {
			useServerStore.setState({
				ownUserId: 1,
				voiceMap: {
					5: {
						users: {
							10: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
						},
					},
				},
			});

			dispatchVoiceSession({
				type: 'ReconnectIntentCaptured',
				pending: {
					channelId: 5,
					micMuted: false,
					soundMuted: false,
					peerUserIds: [10],
					expiresAt: Date.now() + VOICE_RECONNECT_INTENT_TTL_MS,
				},
			});

			expect(resolveVoiceRecoveryAction()).toEqual({ kind: 'session-missing', channelId: 5 });
		});

		it('returns session-missing when the channel has no state at all', () => {
			useServerStore.setState({
				ownUserId: 1,
				voiceMap: {},
			});

			dispatchVoiceSession({
				type: 'ReconnectIntentCaptured',
				pending: {
					channelId: 5,
					micMuted: false,
					soundMuted: false,
					peerUserIds: [],
					expiresAt: Date.now() + VOICE_RECONNECT_INTENT_TTL_MS,
				},
			});

			expect(resolveVoiceRecoveryAction()).toEqual({ kind: 'session-missing', channelId: 5 });
		});

		it('returns none when pendingVoiceReconnect has expired', () => {
			useServerStore.setState({
				ownUserId: 1,
				voiceMap: {
					5: {
						users: {
							1: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
						},
					},
				},
			});

			dispatchVoiceSession({
				type: 'ReconnectIntentCaptured',
				pending: {
					channelId: 5,
					micMuted: false,
					soundMuted: false,
					peerUserIds: [],
					expiresAt: Date.now() - 1,
				},
			});

			expect(resolveVoiceRecoveryAction()).toEqual({ kind: 'none' });
		});
	});

	describe('ensureVoiceReconnectStarted', () => {
		it('sets reconnectingSince when recovery has not started yet', () => {
			const startedAt = 1234;

			ensureVoiceReconnectStarted(startedAt);

			expect(getReconnectingSince()).toBe(startedAt);
		});

		it('preserves the original reconnect timestamp when called again', () => {
			ensureVoiceReconnectStarted(1234);

			ensureVoiceReconnectStarted(5678);

			expect(getReconnectingSince()).toBe(1234);
		});

		it('lets a synchronous command runner observe current machine state', () => {
			useServerStore.setState({
				ownUserId: 1,
				currentVoiceChannelId: 5,
				voiceMap: {
					5: { users: { 1: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false } } },
				},
			});
			captureVoiceReconnectIntentForCurrentSession();

			const observed: Array<number | undefined> = [];
			const unregister = registerVoiceSessionCommandRunner((commands) => {
				if (commands.length > 0) {
					observed.push(getReconnectingSince());
				}
			});

			try {
				ensureVoiceReconnectStarted(1234);
			} finally {
				unregister();
			}

			expect(observed.length).toBeGreaterThan(0);
			for (const reconnectingSince of observed) {
				expect(reconnectingSince).toBe(1234);
			}
		});
	});

	describe('reconnect authentication gate', () => {
		it('starts unauthenticated and toggles with the WS auth lifecycle', () => {
			expect(getReconnectAuthenticated()).toBe(false);

			markVoiceReconnectSessionAuthenticated();
			expect(getReconnectAuthenticated()).toBe(true);

			// A subsequent WS drop must re-gate recovery until the next joinServer.
			markVoiceReconnectSessionUnauthenticated();
			expect(getReconnectAuthenticated()).toBe(false);
		});

		it('resets the auth gate when recovery is cleared', () => {
			markVoiceReconnectSessionAuthenticated();

			clearVoiceReconnectRecovery('user-started-voice-join');

			expect(getReconnectAuthenticated()).toBe(false);
		});
	});

	describe('direct machine selectors', () => {
		it('reflect coordinator actions without a projection', () => {
			useServerStore.setState({
				ownUserId: 1,
				currentVoiceChannelId: 5,
				voiceMap: {
					5: { users: { 1: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false } } },
				},
			});
			captureVoiceReconnectIntentForCurrentSession();
			ensureVoiceReconnectStarted(1234);
			markVoiceReconnectSessionAuthenticated();

			expect(getPendingVoiceReconnect()).toBeDefined();
			expect(getReconnectingSince()).toBe(1234);
			expect(getReconnectAuthenticated()).toBe(true);
			expect(getVoiceReconnectSuppression()).toBeUndefined();
		});
	});

	describe('getValidPendingVoiceReconnect', () => {
		it('returns the pending reconnect when it has not expired', () => {
			dispatchVoiceSession({
				type: 'ReconnectIntentCaptured',
				pending: {
					channelId: 5,
					micMuted: false,
					soundMuted: false,
					peerUserIds: [10],
					expiresAt: Date.now() + 10_000,
				},
			});

			expect(getValidPendingVoiceReconnect()).toEqual({
				channelId: 5,
				micMuted: false,
				soundMuted: false,
				peerUserIds: [10],
				expiresAt: expect.any(Number),
			});
		});

		it('returns undefined once the pending reconnect has expired', () => {
			dispatchVoiceSession({
				type: 'ReconnectIntentCaptured',
				pending: {
					channelId: 5,
					micMuted: false,
					soundMuted: false,
					peerUserIds: [],
					expiresAt: Date.now() - 1,
				},
			});

			expect(getValidPendingVoiceReconnect()).toBeUndefined();
		});
	});

	describe('isVoiceReconnectPeerSuppressed', () => {
		it('returns true only for peers in the same channel before suppression expiry', () => {
			dispatchVoiceSession({
				type: 'ReconnectSuppressionChanged',
				suppression: {
					channelId: 7,
					peerUserIds: [10, 20],
					expiresAt: Date.now() + 10_000,
				},
			});

			expect(isVoiceReconnectPeerSuppressed(7, 10)).toBe(true);
			expect(isVoiceReconnectPeerSuppressed(7, 30)).toBe(false);
			expect(isVoiceReconnectPeerSuppressed(8, 10)).toBe(false);
		});

		it('returns false after suppression expiry', () => {
			dispatchVoiceSession({
				type: 'ReconnectSuppressionChanged',
				suppression: {
					channelId: 7,
					peerUserIds: [10],
					expiresAt: Date.now() - 1,
				},
			});

			expect(isVoiceReconnectPeerSuppressed(7, 10)).toBe(false);
		});
	});
});
