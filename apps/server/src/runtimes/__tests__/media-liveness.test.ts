import { describe, expect, test } from 'bun:test';
import { evaluateMediaLiveness, type TMediaLivenessState } from '../media-liveness';

const TIMEOUT = 30_000;

describe('evaluateMediaLiveness', () => {
	test('first sample baselines without signalling and captures the timeout', () => {
		const { next, shouldSignalFailure } = evaluateMediaLiveness(
			undefined,
			{ transportKey: 'c1:p1', bytesReceived: 1_000, now: 1_000 },
			TIMEOUT,
		);

		expect(shouldSignalFailure).toBe(false);
		expect(next).toEqual({
			transportKey: 'c1:p1',
			lastBytesReceived: 1_000,
			lastProgressAt: 1_000,
			timeoutMs: TIMEOUT,
			failed: false,
		});
	});

	test('advancing bytes keeps the session alive and moves the progress mark', () => {
		const previous: TMediaLivenessState = {
			transportKey: 'c1:p1',
			lastBytesReceived: 1_000,
			lastProgressAt: 1_000,
			timeoutMs: TIMEOUT,
			failed: false,
		};

		const { next, shouldSignalFailure } = evaluateMediaLiveness(
			previous,
			{ transportKey: 'c1:p1', bytesReceived: 1_500, now: 6_000 },
			TIMEOUT,
		);

		expect(shouldSignalFailure).toBe(false);
		expect(next.lastBytesReceived).toBe(1_500);
		expect(next.lastProgressAt).toBe(6_000);
		expect(next.failed).toBe(false);
	});

	test('flatlined bytes inside the timeout window do not signal', () => {
		const previous: TMediaLivenessState = {
			transportKey: 'c1:p1',
			lastBytesReceived: 1_000,
			lastProgressAt: 1_000,
			timeoutMs: TIMEOUT,
			failed: false,
		};

		const { shouldSignalFailure, next } = evaluateMediaLiveness(
			previous,
			{ transportKey: 'c1:p1', bytesReceived: 1_000, now: 1_000 + TIMEOUT - 1 },
			TIMEOUT,
		);

		expect(shouldSignalFailure).toBe(false);
		expect(next.failed).toBe(false);
		// Progress mark stays put so the timeout keeps accruing.
		expect(next.lastProgressAt).toBe(1_000);
	});

	test('flatlined bytes past the timeout signal exactly once', () => {
		const previous: TMediaLivenessState = {
			transportKey: 'c1:p1',
			lastBytesReceived: 1_000,
			lastProgressAt: 1_000,
			timeoutMs: TIMEOUT,
			failed: false,
		};

		const first = evaluateMediaLiveness(
			previous,
			{ transportKey: 'c1:p1', bytesReceived: 1_000, now: 1_000 + TIMEOUT },
			TIMEOUT,
		);

		expect(first.shouldSignalFailure).toBe(true);
		expect(first.next.failed).toBe(true);

		// Still dead on the next tick — must not re-signal.
		const second = evaluateMediaLiveness(
			first.next,
			{ transportKey: 'c1:p1', bytesReceived: 1_000, now: 1_000 + TIMEOUT * 2 },
			TIMEOUT,
		);

		expect(second.shouldSignalFailure).toBe(false);
		expect(second.next.failed).toBe(true);
	});

	test('the timeout is captured at baseline and not re-read on continuation', () => {
		// Baseline with a long timeout...
		const baseline = evaluateMediaLiveness(
			undefined,
			{ transportKey: 'c1:p1', bytesReceived: 1_000, now: 0 },
			60_000,
		).next;

		expect(baseline.timeoutMs).toBe(60_000);

		// ...then a continuation tick passing a *shorter* timeout must not shrink
		// the deadline (jitter stability): 40s elapsed is still within the 60s
		// captured at baseline, so no signal despite the 30s argument.
		const { shouldSignalFailure, next } = evaluateMediaLiveness(
			baseline,
			{ transportKey: 'c1:p1', bytesReceived: 1_000, now: 40_000 },
			TIMEOUT,
		);

		expect(shouldSignalFailure).toBe(false);
		expect(next.timeoutMs).toBe(60_000);
	});

	test('a recovered same-generation transport clears the failure latch', () => {
		const failed: TMediaLivenessState = {
			transportKey: 'c1:p1',
			lastBytesReceived: 1_000,
			lastProgressAt: 1_000,
			timeoutMs: TIMEOUT,
			failed: true,
		};

		const { next, shouldSignalFailure } = evaluateMediaLiveness(
			failed,
			{ transportKey: 'c1:p1', bytesReceived: 2_000, now: 99_000 },
			TIMEOUT,
		);

		expect(shouldSignalFailure).toBe(false);
		expect(next.failed).toBe(false);
		expect(next.lastBytesReceived).toBe(2_000);
		// Same generation — the captured timeout is preserved.
		expect(next.timeoutMs).toBe(TIMEOUT);
	});

	test('new transports (recovery cycle) rebaseline even if byte count drops', () => {
		const previous: TMediaLivenessState = {
			transportKey: 'c1:p1',
			lastBytesReceived: 50_000,
			lastProgressAt: 1_000,
			timeoutMs: TIMEOUT,
			failed: true,
		};

		// Fresh transports start their byte counter from zero; the changed key must
		// force a rebaseline rather than read as a flatline against the old total,
		// and capture the new (possibly re-jittered) timeout.
		const { next, shouldSignalFailure } = evaluateMediaLiveness(
			previous,
			{ transportKey: 'c2:p2', bytesReceived: 0, now: 1_000 + TIMEOUT * 5 },
			55_000,
		);

		expect(shouldSignalFailure).toBe(false);
		expect(next).toEqual({
			transportKey: 'c2:p2',
			lastBytesReceived: 0,
			lastProgressAt: 1_000 + TIMEOUT * 5,
			timeoutMs: 55_000,
			failed: false,
		});
	});
});
