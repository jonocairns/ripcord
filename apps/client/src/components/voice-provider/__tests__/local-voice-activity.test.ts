import { describe, expect, it } from 'bun:test';
import { getAudioLevelFromStats, startLocalVoiceActivityMonitor } from '../local-voice-activity';

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
