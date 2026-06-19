import { describe, expect, test } from 'bun:test';
import {
	type ClientVoiceActivityLease,
	isClientVoiceActivityLeaseActive,
	resolveClientVoiceActivity,
} from '../voice-activity-lease';

const baseContext = {
	currentProducerId: 'producer-1',
	micMuted: false,
	now: 1_000,
};

describe('resolveClientVoiceActivity', () => {
	test('accepts a report bound to the current producer and issues a lease', () => {
		const decision = resolveClientVoiceActivity(
			undefined,
			{ producerId: 'producer-1', seq: 1, isSpeaking: true },
			baseContext,
			1_000,
		);

		expect(decision).toEqual({
			accept: true,
			isSpeaking: true,
			lease: { producerId: 'producer-1', expiresAt: 2_000 },
			ordering: { producerId: 'producer-1', lastSeq: 1 },
		});
	});

	test('rejects a report whose producer is not the current one', () => {
		expect(
			resolveClientVoiceActivity(undefined, { producerId: 'old-producer', seq: 1, isSpeaking: true }, baseContext),
		).toEqual({ accept: false });
	});

	test('rejects a report when the user has no current producer', () => {
		expect(
			resolveClientVoiceActivity(
				undefined,
				{ producerId: 'producer-1', seq: 1, isSpeaking: true },
				{ ...baseContext, currentProducerId: undefined },
			),
		).toEqual({ accept: false });
	});

	test('rejects a true report from a muted user but still allows false', () => {
		expect(
			resolveClientVoiceActivity(
				undefined,
				{ producerId: 'producer-1', seq: 1, isSpeaking: true },
				{ ...baseContext, micMuted: true },
			),
		).toEqual({ accept: false });

		const falseDecision = resolveClientVoiceActivity(
			undefined,
			{ producerId: 'producer-1', seq: 1, isSpeaking: false },
			{ ...baseContext, micMuted: true },
		);
		expect(falseDecision.accept).toBe(true);
	});

	test('drops a reordered report using ordering state that can outlive the lease', () => {
		const current = { producerId: 'producer-1', lastSeq: 5 };

		expect(
			resolveClientVoiceActivity(current, { producerId: 'producer-1', seq: 5, isSpeaking: false }, baseContext),
		).toEqual({ accept: false });
		expect(
			resolveClientVoiceActivity(current, { producerId: 'producer-1', seq: 6, isSpeaking: false }, baseContext).accept,
		).toBe(true);
	});

	test('accepts a low sequence from a new producer as a fresh baseline', () => {
		const current = { producerId: 'old-producer', lastSeq: 99 };

		const decision = resolveClientVoiceActivity(
			current,
			{ producerId: 'producer-1', seq: 1, isSpeaking: true },
			baseContext,
		);
		expect(decision.accept).toBe(true);
	});
});

describe('isClientVoiceActivityLeaseActive', () => {
	test('is active before expiry and inactive at/after it', () => {
		const lease: ClientVoiceActivityLease = { producerId: 'producer-1', expiresAt: 2_000 };

		expect(isClientVoiceActivityLeaseActive(lease, 1_999)).toBe(true);
		expect(isClientVoiceActivityLeaseActive(lease, 2_000)).toBe(false);
		expect(isClientVoiceActivityLeaseActive(lease, 2_001)).toBe(false);
		expect(isClientVoiceActivityLeaseActive(undefined, 0)).toBe(false);
	});
});
