import { describe, expect, it } from 'bun:test';
import {
	getAudioLevelFromStats,
	resolveActivityBroadcast,
	startLocalVoiceActivityMonitor,
} from '../local-voice-activity';

const createRtcStat = (overrides: Record<string, unknown>): RTCStats => {
	return {
		id: 'stat-1',
		timestamp: 1,
		type: 'media-source',
		...overrides,
	} as unknown as RTCStats;
};

const createStatsReport = (stats: RTCStats[]): RTCStatsReport => {
	return new Map(stats.map((stat) => [stat.id, stat])) as unknown as RTCStatsReport;
};

const wait = (durationMs: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, durationMs);
	});

describe('getAudioLevelFromStats', () => {
	it('returns the highest normalized audio level from audio stats', () => {
		const report = createStatsReport([
			createRtcStat({
				id: 'video-source',
				kind: 'video',
				audioLevel: 0.9,
			}),
			createRtcStat({
				id: 'audio-source',
				kind: 'audio',
				audioLevel: 0.42,
			}),
			createRtcStat({
				id: 'audio-track',
				mediaType: 'audio',
				audioLevel: 0.67,
			}),
		]);

		expect(getAudioLevelFromStats(report)).toBe(0.67);
	});

	it('returns undefined when the report does not expose audio levels', () => {
		const report = createStatsReport([
			createRtcStat({
				id: 'outbound-audio',
				type: 'outbound-rtp',
				kind: 'audio',
			}),
		]);

		expect(getAudioLevelFromStats(report)).toBeUndefined();
	});
});

describe('startLocalVoiceActivityMonitor', () => {
	it('reports speech immediately and applies a release delay', async () => {
		const loudReport = createStatsReport([
			createRtcStat({
				kind: 'audio',
				audioLevel: 0.4,
			}),
		]);
		const silentReport = createStatsReport([
			createRtcStat({
				kind: 'audio',
				audioLevel: 0,
			}),
		]);
		let sampleCount = 0;
		const updates: Array<boolean | undefined> = [];
		const stop = startLocalVoiceActivityMonitor({
			statsProvider: {
				getStats: async () => {
					sampleCount += 1;
					return sampleCount === 1 ? loudReport : silentReport;
				},
			},
			onUpdate: (isSpeaking) => {
				updates.push(isSpeaking);
			},
			pollIntervalMs: 5,
			releaseDelayMs: 20,
		});

		await wait(10);
		expect(updates).toEqual([false, true]);

		await wait(30);
		expect(updates).toEqual([false, true, false]);

		stop();
		expect(updates).toEqual([false, true, false, undefined]);
	});

	it('falls back to server activity when stats do not expose an audio level', async () => {
		const updates: Array<boolean | undefined> = [];
		const stop = startLocalVoiceActivityMonitor({
			statsProvider: {
				getStats: async () => createStatsReport([]),
			},
			onUpdate: (isSpeaking) => {
				updates.push(isSpeaking);
			},
			pollIntervalMs: 50,
		});

		await wait(5);
		expect(updates).toEqual([false, undefined]);

		stop();
	});
});

describe('resolveActivityBroadcast', () => {
	it('never broadcasts before a measured true has been announced', () => {
		// A client that can only ever emit undefined (e.g. Firefox) or a baseline
		// false must not broadcast — it would otherwise claim server authority and
		// disable the observer for itself.
		expect(resolveActivityBroadcast(undefined, false)).toEqual({ broadcast: undefined, hasAnnouncedSpeaking: false });
		expect(resolveActivityBroadcast(false, false)).toEqual({ broadcast: undefined, hasAnnouncedSpeaking: false });
	});

	it('broadcasts a measured true and latches it', () => {
		expect(resolveActivityBroadcast(true, false)).toEqual({ broadcast: true, hasAnnouncedSpeaking: true });
	});

	it('broadcasts a false only after a true was announced, then clears the latch', () => {
		expect(resolveActivityBroadcast(false, true)).toEqual({ broadcast: false, hasAnnouncedSpeaking: false });
	});

	it('keeps the latch through an undefined reading so a lost signal is not announced', () => {
		expect(resolveActivityBroadcast(undefined, true)).toEqual({ broadcast: undefined, hasAnnouncedSpeaking: true });
	});
});
