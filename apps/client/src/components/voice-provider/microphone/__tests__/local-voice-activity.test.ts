import { describe, expect, it } from 'bun:test';
import {
	type ActivityBroadcastState,
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

// Virtual clock for the activity monitor. Real timers made these tests flaky:
// the monitor advances its state machine on setTimeout/Date.now() and the
// assertions checked fixed wall-clock offsets, so under CI load the sample count
// at each checkpoint drifted. Driving a manual scheduler makes the sample
// sequence deterministic regardless of how fast timers actually fire.
const createManualScheduler = () => {
	let currentTime = 0;
	let nextId = 0;
	const timers = new Map<number, { time: number; handler: () => void }>();

	const scheduler = {
		now: () => currentTime,
		setTimeout: (handler: () => void, delayMs: number) => {
			nextId += 1;
			timers.set(nextId, { time: currentTime + delayMs, handler });
			return nextId as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
			timers.delete(handle as unknown as number);
		},
	};

	// Let awaited microtasks (statsProvider.getStats) settle so each sample's
	// continuation schedules its next timer before we look for the next one.
	const flushMicrotasks = async () => {
		for (let i = 0; i < 5; i += 1) {
			await Promise.resolve();
		}
	};

	// Advance virtual time to now + ms, firing every timer that comes due in
	// chronological order and flushing microtasks between fires so the async poll
	// loop stays deterministic.
	const advance = async (ms: number) => {
		const target = currentTime + ms;
		await flushMicrotasks();

		for (let guard = 0; guard < 100_000; guard += 1) {
			let dueId: number | undefined;
			let dueTime = Number.POSITIVE_INFINITY;

			for (const [id, timer] of timers) {
				if (timer.time <= target && timer.time < dueTime) {
					dueTime = timer.time;
					dueId = id;
				}
			}

			if (dueId === undefined) {
				break;
			}

			const timer = timers.get(dueId)!;
			timers.delete(dueId);
			currentTime = timer.time;
			timer.handler();
			await flushMicrotasks();
		}

		currentTime = target;
	};

	return { scheduler, advance };
};

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
	it('waits for quiet startup samples, requires sustained speech, and applies a release delay', async () => {
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
		const { scheduler, advance } = createManualScheduler();
		const stop = startLocalVoiceActivityMonitor({
			statsProvider: {
				getStats: async () => {
					sampleCount += 1;
					return sampleCount <= 3 || sampleCount >= 7 ? silentReport : loudReport;
				},
			},
			onUpdate: (isSpeaking) => {
				updates.push(isSpeaking);
			},
			pollIntervalMs: 5,
			releaseDelayMs: 20,
			scheduler,
		});

		await advance(20);
		expect(updates).toEqual([undefined, false]);

		await advance(15);
		expect(updates).toEqual([undefined, false, true]);

		await advance(30);
		expect(updates).toEqual([undefined, false, true, false]);

		stop();
		expect(updates).toEqual([undefined, false, true, false, undefined]);
	});

	it('does not report a loud startup transient before the microphone settles', async () => {
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
		const { scheduler, advance } = createManualScheduler();
		const stop = startLocalVoiceActivityMonitor({
			statsProvider: {
				getStats: async () => {
					sampleCount += 1;
					return sampleCount <= 8 ? loudReport : silentReport;
				},
			},
			onUpdate: (isSpeaking) => {
				updates.push(isSpeaking);
			},
			pollIntervalMs: 2,
			warmupTimeoutMs: 100,
			scheduler,
		});

		await advance(30);
		expect(updates).toEqual([undefined, false]);

		stop();
		expect(updates).toEqual([undefined, false, undefined]);
	});

	it('allows sustained speech after the bounded warm-up timeout', async () => {
		const loudReport = createStatsReport([
			createRtcStat({
				kind: 'audio',
				audioLevel: 0.4,
			}),
		]);
		const updates: Array<boolean | undefined> = [];
		const { scheduler, advance } = createManualScheduler();
		const stop = startLocalVoiceActivityMonitor({
			statsProvider: {
				getStats: async () => loudReport,
			},
			onUpdate: (isSpeaking) => {
				updates.push(isSpeaking);
			},
			pollIntervalMs: 5,
			warmupTimeoutMs: 15,
			scheduler,
		});

		await advance(35);
		expect(updates).toEqual([undefined, true]);

		stop();
		expect(updates).toEqual([undefined, true, undefined]);
	});

	it('falls back to server activity when stats do not expose an audio level', async () => {
		const updates: Array<boolean | undefined> = [];
		const { scheduler, advance } = createManualScheduler();
		const stop = startLocalVoiceActivityMonitor({
			statsProvider: {
				getStats: async () => createStatsReport([]),
			},
			onUpdate: (isSpeaking) => {
				updates.push(isSpeaking);
			},
			pollIntervalMs: 50,
			scheduler,
		});

		await advance(5);
		expect(updates).toEqual([undefined]);

		stop();
	});
});

describe('resolveActivityBroadcast', () => {
	const emptyState: ActivityBroadcastState = {
		producerId: undefined,
		hasAnnouncedSpeaking: false,
	};

	it('never broadcasts before a measured true has been announced', () => {
		// A client that can only ever emit undefined (e.g. Firefox) or a baseline
		// false must not broadcast — it would otherwise claim server authority and
		// disable the observer for itself.
		const unavailable = resolveActivityBroadcast(undefined, 'producer-1', emptyState);

		expect(unavailable).toEqual({
			broadcast: undefined,
			state: { producerId: 'producer-1', hasAnnouncedSpeaking: false },
		});
		expect(resolveActivityBroadcast(false, 'producer-1', unavailable.state)).toEqual({
			broadcast: undefined,
			state: { producerId: 'producer-1', hasAnnouncedSpeaking: false },
		});
	});

	it('broadcasts a measured true and latches it', () => {
		expect(resolveActivityBroadcast(true, 'producer-1', emptyState)).toEqual({
			broadcast: true,
			state: { producerId: 'producer-1', hasAnnouncedSpeaking: true },
		});
	});

	it('broadcasts a false only after a true was announced, then clears the latch', () => {
		const speakingState: ActivityBroadcastState = {
			producerId: 'producer-1',
			hasAnnouncedSpeaking: true,
		};

		expect(resolveActivityBroadcast(false, 'producer-1', speakingState)).toEqual({
			broadcast: false,
			state: { producerId: 'producer-1', hasAnnouncedSpeaking: false },
		});
	});

	it('keeps the latch through an undefined reading so a lost signal is not announced', () => {
		const speakingState: ActivityBroadcastState = {
			producerId: 'producer-1',
			hasAnnouncedSpeaking: true,
		};

		expect(resolveActivityBroadcast(undefined, 'producer-1', speakingState)).toEqual({
			broadcast: undefined,
			state: speakingState,
		});
	});

	it('does not carry speaking authority to a replacement producer', () => {
		const oldProducerState: ActivityBroadcastState = {
			producerId: 'producer-1',
			hasAnnouncedSpeaking: true,
		};
		const replacementBaseline = resolveActivityBroadcast(false, 'producer-2', oldProducerState);

		expect(replacementBaseline).toEqual({
			broadcast: undefined,
			state: { producerId: 'producer-2', hasAnnouncedSpeaking: false },
		});
		expect(resolveActivityBroadcast(undefined, 'producer-2', replacementBaseline.state)).toEqual({
			broadcast: undefined,
			state: { producerId: 'producer-2', hasAnnouncedSpeaking: false },
		});
	});
});
