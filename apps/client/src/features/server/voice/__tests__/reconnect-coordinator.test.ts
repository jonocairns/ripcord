import { beforeEach, describe, expect, it } from 'bun:test';
import { useServerStore } from '../../slice';
import {
	clearVoiceReconnectRecovery,
	getValidPendingVoiceReconnect,
	isVoiceReconnectPeerSuppressed,
	resolveVoiceRecoveryAction,
	snapshotVoiceReconnectIntent,
	useVoiceReconnectStore,
} from '../reconnect-coordinator';

describe('voice reconnect coordinator', () => {
	beforeEach(() => {
		useServerStore.getState().resetState();
		useVoiceReconnectStore.getState().resetState();
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

			const expiresAt = Date.now() + 65_000;
			snapshotVoiceReconnectIntent({ expiresAt });

			const { pendingVoiceReconnect } = useVoiceReconnectStore.getState();

			expect(pendingVoiceReconnect).toBeDefined();
			if (!pendingVoiceReconnect) return;
			expect(pendingVoiceReconnect.channelId).toBe(5);
			expect(pendingVoiceReconnect.micMuted).toBe(true);
			expect(pendingVoiceReconnect.soundMuted).toBe(false);
			expect(pendingVoiceReconnect.peerUserIds).toEqual([10, 20]);
			expect(pendingVoiceReconnect.expiresAt).toBe(expiresAt);
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

			snapshotVoiceReconnectIntent({ expiresAt: Date.now() + 65_000 });

			// Mutate the voiceMap after snapshot
			useServerStore.getState().addUserToVoiceChannel({
				channelId: 5,
				userId: 30,
				state: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
			});

			const { pendingVoiceReconnect } = useVoiceReconnectStore.getState();

			expect(pendingVoiceReconnect).toBeDefined();
			if (!pendingVoiceReconnect) return;
			expect(pendingVoiceReconnect.peerUserIds).toEqual([10, 20]);
		});

		it('no-ops when currentVoiceChannelId is undefined', () => {
			useServerStore.setState({
				ownUserId: 1,
				currentVoiceChannelId: undefined,
			});

			snapshotVoiceReconnectIntent({ expiresAt: Date.now() + 65_000 });

			expect(useVoiceReconnectStore.getState().pendingVoiceReconnect).toBeUndefined();
		});

		it('no-ops when ownUserId is undefined', () => {
			useServerStore.setState({
				ownUserId: undefined,
				currentVoiceChannelId: 5,
			});

			snapshotVoiceReconnectIntent({ expiresAt: Date.now() + 65_000 });

			expect(useVoiceReconnectStore.getState().pendingVoiceReconnect).toBeUndefined();
		});
	});

	describe('clearVoiceReconnectRecovery', () => {
		it('atomically clears all three state fields', () => {
			useVoiceReconnectStore.getState().setPendingVoiceReconnect({
				channelId: 5,
				micMuted: false,
				soundMuted: false,
				peerUserIds: [10],
				expiresAt: Date.now() + 65_000,
			});
			useVoiceReconnectStore.getState().setReconnectingSince(Date.now());
			useVoiceReconnectStore.getState().setVoiceReconnectSuppression({
				channelId: 5,
				peerUserIds: [10],
				expiresAt: Date.now() + 10_000,
			});

			clearVoiceReconnectRecovery('user-left-voice');

			const state = useVoiceReconnectStore.getState();
			expect(state.pendingVoiceReconnect).toBeUndefined();
			expect(state.reconnectingSince).toBeUndefined();
			expect(state.voiceReconnectSuppression).toBeUndefined();
		});

		it('is idempotent', () => {
			clearVoiceReconnectRecovery('app-teardown');
			clearVoiceReconnectRecovery('app-teardown');

			const state = useVoiceReconnectStore.getState();
			expect(state.pendingVoiceReconnect).toBeUndefined();
			expect(state.reconnectingSince).toBeUndefined();
			expect(state.voiceReconnectSuppression).toBeUndefined();
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

			useVoiceReconnectStore.getState().setPendingVoiceReconnect({
				channelId: 5,
				micMuted: false,
				soundMuted: false,
				peerUserIds: [],
				expiresAt: Date.now() + 65_000,
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

			useVoiceReconnectStore.getState().setPendingVoiceReconnect({
				channelId: 5,
				micMuted: false,
				soundMuted: false,
				peerUserIds: [10],
				expiresAt: Date.now() + 65_000,
			});

			expect(resolveVoiceRecoveryAction()).toEqual({ kind: 'session-missing', channelId: 5 });
		});

		it('returns session-missing when the channel has no state at all', () => {
			useServerStore.setState({
				ownUserId: 1,
				voiceMap: {},
			});

			useVoiceReconnectStore.getState().setPendingVoiceReconnect({
				channelId: 5,
				micMuted: false,
				soundMuted: false,
				peerUserIds: [],
				expiresAt: Date.now() + 65_000,
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

			useVoiceReconnectStore.getState().setPendingVoiceReconnect({
				channelId: 5,
				micMuted: false,
				soundMuted: false,
				peerUserIds: [],
				expiresAt: Date.now() - 1,
			});

			expect(resolveVoiceRecoveryAction()).toEqual({ kind: 'none' });
		});
	});

	describe('getValidPendingVoiceReconnect', () => {
		it('returns the pending reconnect when it has not expired', () => {
			useVoiceReconnectStore.getState().setPendingVoiceReconnect({
				channelId: 5,
				micMuted: false,
				soundMuted: false,
				peerUserIds: [10],
				expiresAt: Date.now() + 10_000,
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
			useVoiceReconnectStore.getState().setPendingVoiceReconnect({
				channelId: 5,
				micMuted: false,
				soundMuted: false,
				peerUserIds: [],
				expiresAt: Date.now() - 1,
			});

			expect(getValidPendingVoiceReconnect()).toBeUndefined();
		});
	});

	describe('isVoiceReconnectPeerSuppressed', () => {
		it('returns true only for peers in the same channel before suppression expiry', () => {
			useVoiceReconnectStore.getState().setVoiceReconnectSuppression({
				channelId: 7,
				peerUserIds: [10, 20],
				expiresAt: Date.now() + 10_000,
			});

			expect(isVoiceReconnectPeerSuppressed(7, 10)).toBe(true);
			expect(isVoiceReconnectPeerSuppressed(7, 30)).toBe(false);
			expect(isVoiceReconnectPeerSuppressed(8, 10)).toBe(false);
		});

		it('returns false after suppression expiry', () => {
			useVoiceReconnectStore.getState().setVoiceReconnectSuppression({
				channelId: 7,
				peerUserIds: [10],
				expiresAt: Date.now() - 1,
			});

			expect(isVoiceReconnectPeerSuppressed(7, 10)).toBe(false);
		});
	});
});
