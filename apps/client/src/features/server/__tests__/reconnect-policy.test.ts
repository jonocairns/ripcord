import { describe, expect, it } from 'bun:test';
import { DisconnectCode } from '@sharkord/shared';
import {
	resolvePendingVoiceReconnectChannelIdOnDisconnect,
	resolveTransportFailureVoiceReconnectState,
} from '../reconnect-policy';

describe('resolvePendingVoiceReconnectChannelIdOnDisconnect', () => {
	it('prefers the active voice channel when a reconnectable disconnect happens', () => {
		expect(
			resolvePendingVoiceReconnectChannelIdOnDisconnect({
				wasConnected: true,
				disconnectCode: DisconnectCode.UNEXPECTED,
				currentVoiceChannelId: 42,
				pendingVoiceChannelId: 77,
			}),
		).toBe(42);
	});

	it('keeps an existing pending voice channel when the active channel is already cleared', () => {
		expect(
			resolvePendingVoiceReconnectChannelIdOnDisconnect({
				wasConnected: true,
				disconnectCode: DisconnectCode.UNEXPECTED,
				currentVoiceChannelId: undefined,
				pendingVoiceChannelId: 77,
			}),
		).toBe(77);
	});

	it('does not keep pending voice state for non-reconnectable disconnects', () => {
		expect(
			resolvePendingVoiceReconnectChannelIdOnDisconnect({
				wasConnected: true,
				disconnectCode: DisconnectCode.KICKED,
				currentVoiceChannelId: 42,
				pendingVoiceChannelId: 77,
			}),
		).toBeUndefined();
	});
});

describe('resolveTransportFailureVoiceReconnectState', () => {
	it('moves the active voice channel into pending reconnect state before cleanup', () => {
		expect(
			resolveTransportFailureVoiceReconnectState({
				isConnected: true,
				currentVoiceChannelId: 42,
			}),
		).toEqual({
			pendingVoiceReconnectChannelId: 42,
			shouldClearCurrentVoiceChannelId: true,
		});
	});

	it('does not spend voice reconnect state when cleanup runs after connectivity is already lost', () => {
		expect(
			resolveTransportFailureVoiceReconnectState({
				isConnected: false,
				currentVoiceChannelId: 42,
			}),
		).toEqual({
			pendingVoiceReconnectChannelId: undefined,
			shouldClearCurrentVoiceChannelId: false,
		});
	});

	it('does nothing when there is no active voice channel to preserve', () => {
		expect(
			resolveTransportFailureVoiceReconnectState({
				isConnected: true,
				currentVoiceChannelId: undefined,
			}),
		).toEqual({
			pendingVoiceReconnectChannelId: undefined,
			shouldClearCurrentVoiceChannelId: false,
		});
	});
});
