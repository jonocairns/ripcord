import { describe, expect, it } from 'bun:test';
import { getAudioLevelFromStatsEntries, resolveVoiceActivityStatsGetter } from '../voice-activity';

const createRtcStat = (overrides: Record<string, unknown>): RTCStats => {
	return {
		id: 'stat-1',
		timestamp: 1,
		type: 'codec',
		...overrides,
	} as unknown as RTCStats;
};

const createStatsReport = (stats: RTCStats[]): RTCStatsReport => {
	return new Map(stats.map((stat) => [stat.id, stat])) as unknown as RTCStatsReport;
};

describe('getAudioLevelFromStatsEntries', () => {
	it('returns the highest normalized audio level from audio stats', () => {
		const stats: RTCStats[] = [
			createRtcStat({
				id: 'video-track',
				type: 'track',
				kind: 'video',
				audioLevel: 0.95,
			}),
			createRtcStat({
				id: 'audio-track',
				type: 'track',
				kind: 'audio',
				audioLevel: 0.42,
			}),
			createRtcStat({
				id: 'media-source',
				type: 'media-source',
				kind: 'audio',
				audioLevel: 0.67,
			}),
		];

		expect(getAudioLevelFromStatsEntries(stats)).toBe(67);
	});

	it('returns undefined when no audio level stats are present', () => {
		const stats: RTCStats[] = [
			createRtcStat({
				id: 'outbound-rtp',
				type: 'outbound-rtp',
				kind: 'audio',
			}),
			createRtcStat({
				id: 'video-media-source',
				type: 'media-source',
				kind: 'video',
				audioLevel: 0.4,
			}),
		];

		expect(getAudioLevelFromStatsEntries(stats)).toBeUndefined();
	});

	it('clamps audio levels into the expected percentage range', () => {
		const stats: RTCStats[] = [
			createRtcStat({
				id: 'negative-level',
				type: 'track',
				kind: 'audio',
				audioLevel: -0.25,
			}),
			createRtcStat({
				id: 'overflow-level',
				type: 'track',
				kind: 'audio',
				audioLevel: 1.75,
			}),
		];

		expect(getAudioLevelFromStatsEntries(stats)).toBe(100);
	});
});

describe('resolveVoiceActivityStatsGetter', () => {
	it('uses the preferred stats getter when local track stats are unavailable', async () => {
		const fallbackReport = createStatsReport([
			createRtcStat({
				id: 'audio-track',
				type: 'track',
				kind: 'audio',
				audioLevel: 0.51,
			}),
		]);

		const getStatsReport = resolveVoiceActivityStatsGetter({
			audioStream: {
				getAudioTracks: () => [{ id: 'mic-track' }],
			} as unknown as MediaStream,
			getPreferredStatsReport: async () => fallbackReport,
		});

		expect(getStatsReport).toBeDefined();
		expect(await getStatsReport?.()).toBe(fallbackReport);
	});

	it('prefers producer stats over local track stats when both are available', async () => {
		const preferredReport = createStatsReport([
			createRtcStat({
				id: 'preferred-audio-track',
				type: 'track',
				kind: 'audio',
				audioLevel: 0.73,
			}),
		]);
		const trackReport = createStatsReport([
			createRtcStat({
				id: 'track-audio-track',
				type: 'track',
				kind: 'audio',
				audioLevel: 0.19,
			}),
		]);
		const track = {
			id: 'mic-track',
			getStats: async () => trackReport,
		};

		const getStatsReport = resolveVoiceActivityStatsGetter({
			audioStream: {
				getAudioTracks: () => [track],
			} as unknown as MediaStream,
			getPreferredStatsReport: async () => preferredReport,
		});

		expect(getStatsReport).toBeDefined();
		expect(await getStatsReport?.()).toBe(preferredReport);
	});
});
