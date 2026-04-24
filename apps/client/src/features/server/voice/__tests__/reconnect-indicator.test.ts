import { describe, expect, it } from 'bun:test';
import {
	getVoiceReconnectIndicatorDelayMs,
	shouldShowVoiceReconnectIndicator,
	VOICE_RECONNECT_INDICATOR_DELAY_MS,
} from '../reconnect-indicator';

describe('voice reconnect indicator', () => {
	it('waits four seconds before showing the indicator', () => {
		const reconnectingSince = 10_000;

		expect(getVoiceReconnectIndicatorDelayMs(reconnectingSince, reconnectingSince)).toBe(
			VOICE_RECONNECT_INDICATOR_DELAY_MS,
		);
		expect(getVoiceReconnectIndicatorDelayMs(reconnectingSince, reconnectingSince + 3_999)).toBe(1);
		expect(shouldShowVoiceReconnectIndicator(undefined, reconnectingSince, reconnectingSince + 3_999)).toBe(false);
	});

	it('shows once the reconnect delay has elapsed', () => {
		const reconnectingSince = 10_000;
		const now = reconnectingSince + VOICE_RECONNECT_INDICATOR_DELAY_MS;

		expect(getVoiceReconnectIndicatorDelayMs(reconnectingSince, now)).toBe(0);
		expect(shouldShowVoiceReconnectIndicator(undefined, reconnectingSince, now)).toBe(true);
		expect(shouldShowVoiceReconnectIndicator(undefined, reconnectingSince, now + 2_000)).toBe(true);
	});

	it('hides immediately when the voice channel is restored', () => {
		const reconnectingSince = 10_000;
		const now = reconnectingSince + VOICE_RECONNECT_INDICATOR_DELAY_MS + 500;

		expect(shouldShowVoiceReconnectIndicator(7, reconnectingSince, now)).toBe(false);
		expect(shouldShowVoiceReconnectIndicator(undefined, undefined, now)).toBe(false);
	});
});
