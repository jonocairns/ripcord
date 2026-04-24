export type VoiceActivity = {
	isSpeaking: boolean;
};

export type VoiceActivityStore = {
	subscribe: (listener: () => void) => () => void;
	getUserActivity: (userId: number) => VoiceActivity;
	setUserActivity: (userId: number, activity: VoiceActivity) => void;
	clearUserActivity: (userId: number) => void;
	clearAll: () => void;
};

type GetVoiceActivityStatsReport = () => Promise<RTCStatsReport | undefined>;

const SPEAKING_THRESHOLD = 8;
const AUDIO_LEVEL_POLL_INTERVAL_MS = 50;

const EMPTY_VOICE_ACTIVITY: VoiceActivity = {
	isSpeaking: false,
};

const createVoiceActivityStore = (): VoiceActivityStore => {
	const listeners = new Set<() => void>();
	const activities = new Map<number, VoiceActivity>();

	const emit = () => {
		listeners.forEach((listener) => {
			listener();
		});
	};

	return {
		subscribe: (listener) => {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		},
		getUserActivity: (userId) => {
			return activities.get(userId) ?? EMPTY_VOICE_ACTIVITY;
		},
		setUserActivity: (userId, activity) => {
			const previous = activities.get(userId);

			if (previous?.isSpeaking === activity.isSpeaking) {
				return;
			}

			activities.set(userId, activity);
			emit();
		},
		clearUserActivity: (userId) => {
			if (!activities.has(userId)) {
				return;
			}

			activities.delete(userId);
			emit();
		},
		clearAll: () => {
			if (activities.size === 0) {
				return;
			}

			activities.clear();
			emit();
		},
	};
};

const hasTrackStats = (
	track: MediaStreamTrack | undefined,
): track is MediaStreamTrack & {
	getStats: () => Promise<RTCStatsReport>;
} => {
	return track !== undefined && typeof Reflect.get(track, 'getStats') === 'function';
};

const resolveVoiceActivityStatsGetter = ({
	audioStream,
	getPreferredStatsReport,
}: {
	audioStream: MediaStream;
	getPreferredStatsReport?: GetVoiceActivityStatsReport;
}): GetVoiceActivityStatsReport | undefined => {
	const sourceTrack = audioStream.getAudioTracks()[0];
	const getTrackStatsReport = hasTrackStats(sourceTrack) ? async () => sourceTrack.getStats() : undefined;

	if (!getPreferredStatsReport && !getTrackStatsReport) {
		return undefined;
	}

	return async () => {
		const preferredStatsReport = await getPreferredStatsReport?.();

		if (preferredStatsReport) {
			return preferredStatsReport;
		}

		return getTrackStatsReport?.();
	};
};

const getAudioLevelFromStatsEntries = (stats: Iterable<RTCStats>): number | undefined => {
	let audioLevel: number | undefined;

	for (const stat of stats) {
		if (!('audioLevel' in stat) || typeof stat.audioLevel !== 'number') {
			continue;
		}

		if ('kind' in stat && typeof stat.kind === 'string' && stat.kind !== 'audio') {
			continue;
		}

		if ('mediaType' in stat && typeof stat.mediaType === 'string' && stat.mediaType !== 'audio') {
			continue;
		}

		const normalizedLevel = Math.min(100, Math.max(0, stat.audioLevel * 100));
		audioLevel = audioLevel === undefined ? normalizedLevel : Math.max(audioLevel, normalizedLevel);
	}

	return audioLevel;
};

const toVoiceActivity = (audioLevel: number): VoiceActivity => ({
	isSpeaking: audioLevel > SPEAKING_THRESHOLD,
});

const startVoiceActivityMonitor = (
	audioStream: MediaStream,
	onUpdate: (activity: VoiceActivity) => void,
	options: {
		getPreferredStatsReport?: GetVoiceActivityStatsReport;
	} = {},
): (() => void) => {
	onUpdate(EMPTY_VOICE_ACTIVITY);

	// Prefer stats-based metering over a Web Audio analyser. Chromium/Electron
	// can leak speech-correlated static into active playback when a live in-call
	// track is also attached to a MediaStreamAudioSourceNode.
	const getStatsReport = resolveVoiceActivityStatsGetter({
		audioStream,
		getPreferredStatsReport: options.getPreferredStatsReport,
	});

	if (!getStatsReport) {
		return () => undefined;
	}

	let cancelled = false;
	let timeoutId: number | null = null;
	let previousActivity = EMPTY_VOICE_ACTIVITY;

	const checkAudioLevel = async () => {
		if (cancelled) {
			return;
		}

		try {
			const report = await getStatsReport();
			const normalizedLevel = report ? (getAudioLevelFromStatsEntries(report.values()) ?? 0) : 0;
			const nextActivity = toVoiceActivity(normalizedLevel);

			if (nextActivity.isSpeaking !== previousActivity.isSpeaking) {
				previousActivity = nextActivity;
				onUpdate(nextActivity);
			}
		} catch {
			// Swallow; report silence for this tick and retry on the next poll.
		}

		if (cancelled) {
			return;
		}

		timeoutId = window.setTimeout(() => {
			void checkAudioLevel();
		}, AUDIO_LEVEL_POLL_INTERVAL_MS);
	};

	void checkAudioLevel();

	return () => {
		cancelled = true;

		if (timeoutId !== null) {
			window.clearTimeout(timeoutId);
			timeoutId = null;
		}

		onUpdate(EMPTY_VOICE_ACTIVITY);
	};
};

export {
	createVoiceActivityStore,
	EMPTY_VOICE_ACTIVITY,
	getAudioLevelFromStatsEntries,
	resolveVoiceActivityStatsGetter,
	startVoiceActivityMonitor,
};
