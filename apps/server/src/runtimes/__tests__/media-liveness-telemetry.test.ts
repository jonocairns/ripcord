import { afterEach, describe, expect, test } from 'bun:test';
import {
	flushMediaLivenessReport,
	getMediaLivenessTelemetrySnapshot,
	recordMediaLivenessFailure,
	resetMediaLivenessTelemetryForTests,
} from '../media-liveness-telemetry';

describe('media-liveness telemetry aggregation', () => {
	afterEach(() => {
		resetMediaLivenessTelemetryForTests();
	});

	test('starts with no window', () => {
		expect(getMediaLivenessTelemetrySnapshot()).toBeUndefined();
	});

	test('aggregates fires and de-duplicates users/channels within a window', () => {
		recordMediaLivenessFailure(1, 100);
		recordMediaLivenessFailure(1, 100); // same user + channel
		recordMediaLivenessFailure(1, 101); // new user, same channel
		recordMediaLivenessFailure(2, 102); // new channel + user

		expect(getMediaLivenessTelemetrySnapshot()).toEqual({
			fires: 4,
			distinctUsers: 3,
			distinctChannels: 2,
		});
	});

	test('flush emits at most once and resets the window (anti-spam)', () => {
		// A global outage: many fires in one window.
		for (let i = 0; i < 500; i++) {
			recordMediaLivenessFailure(1, i);
		}

		expect(getMediaLivenessTelemetrySnapshot()?.fires).toBe(500);

		// One flush drains the whole window — i.e. 500 fires => a single report.
		flushMediaLivenessReport();
		expect(getMediaLivenessTelemetrySnapshot()).toBeUndefined();

		// A second flush with nothing pending is a no-op.
		flushMediaLivenessReport();
		expect(getMediaLivenessTelemetrySnapshot()).toBeUndefined();
	});

	test('a new fire after a flush starts a fresh window', () => {
		recordMediaLivenessFailure(1, 100);
		flushMediaLivenessReport();
		expect(getMediaLivenessTelemetrySnapshot()).toBeUndefined();

		recordMediaLivenessFailure(3, 200);
		expect(getMediaLivenessTelemetrySnapshot()).toEqual({
			fires: 1,
			distinctUsers: 1,
			distinctChannels: 1,
		});
	});
});
