// Speaking level is read from WebRTC getStats() rather than a Web Audio
// AnalyserNode tap on the mic track. AGENTS.md cautions that attaching a live
// in-call mic track to a MediaStreamAudioSourceNode can leak speech-correlated
// static into playback on Chromium/Electron. That caution is unconfirmed, but
// getStats sidesteps the risk entirely at negligible cost; if the AnalyserNode
// path is ever verified safe it would remove the Firefox audioLevel gap below.
type LocalVoiceActivityStatsProvider = {
	getStats: () => Promise<RTCStatsReport>;
};

type LocalVoiceActivityUpdate = boolean | undefined;

const LOCAL_VOICE_ACTIVITY_POLL_INTERVAL_MS = 50;
const LOCAL_VOICE_ACTIVITY_RELEASE_DELAY_MS = 350;
// Mirror the server AudioLevelObserver threshold (-60 dBov) so the local
// fast-path and the server signal agree on what counts as speaking. WebRTC
// getStats() audioLevel is linear where 1.0 == 0 dBov, so convert dBov to the
// linear scale: linear = 10^(dBov / 20). Keeping this derived from the same
// dBov value stops the two paths drifting apart.
const LOCAL_VOICE_ACTIVITY_THRESHOLD_DBOV = -60;
const LOCAL_VOICE_ACTIVITY_SPEAKING_THRESHOLD = 10 ** (LOCAL_VOICE_ACTIVITY_THRESHOLD_DBOV / 20);

const getAudioLevelFromStats = (report: RTCStatsReport): number | undefined => {
	let audioLevel: number | undefined;

	for (const stat of report.values()) {
		if (!('audioLevel' in stat) || typeof stat.audioLevel !== 'number') {
			continue;
		}

		if ('kind' in stat && typeof stat.kind === 'string' && stat.kind !== 'audio') {
			continue;
		}

		if ('mediaType' in stat && typeof stat.mediaType === 'string' && stat.mediaType !== 'audio') {
			continue;
		}

		const normalizedLevel = Math.min(1, Math.max(0, stat.audioLevel));
		audioLevel = audioLevel === undefined ? normalizedLevel : Math.max(audioLevel, normalizedLevel);
	}

	return audioLevel;
};

const startLocalVoiceActivityMonitor = ({
	statsProvider,
	onUpdate,
	pollIntervalMs = LOCAL_VOICE_ACTIVITY_POLL_INTERVAL_MS,
	releaseDelayMs = LOCAL_VOICE_ACTIVITY_RELEASE_DELAY_MS,
}: {
	statsProvider: LocalVoiceActivityStatsProvider;
	onUpdate: (isSpeaking: LocalVoiceActivityUpdate) => void;
	pollIntervalMs?: number;
	releaseDelayMs?: number;
}): (() => void) => {
	let cancelled = false;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;
	let currentActivity: LocalVoiceActivityUpdate = false;

	const update = (isSpeaking: LocalVoiceActivityUpdate) => {
		if (currentActivity === isSpeaking) {
			return;
		}

		currentActivity = isSpeaking;
		onUpdate(isSpeaking);
	};

	const clearReleaseTimer = () => {
		if (releaseTimer === undefined) {
			return;
		}

		clearTimeout(releaseTimer);
		releaseTimer = undefined;
	};

	const sample = async () => {
		if (cancelled) {
			return;
		}

		try {
			const report = await statsProvider.getStats();

			if (cancelled) {
				return;
			}

			const audioLevel = getAudioLevelFromStats(report);

			if (audioLevel === undefined) {
				clearReleaseTimer();
				update(undefined);
			} else if (audioLevel > LOCAL_VOICE_ACTIVITY_SPEAKING_THRESHOLD) {
				clearReleaseTimer();
				update(true);
			} else if (currentActivity === true) {
				if (releaseTimer === undefined) {
					releaseTimer = setTimeout(() => {
						releaseTimer = undefined;
						update(false);
					}, releaseDelayMs);
				}
			} else {
				update(false);
			}
		} catch {
			// Keep the last known state and retry. Producer replacement and
			// transport recovery can make an individual stats request fail.
		}

		if (!cancelled) {
			pollTimer = setTimeout(() => {
				void sample();
			}, pollIntervalMs);
		}
	};

	onUpdate(false);
	void sample();

	return () => {
		cancelled = true;

		if (pollTimer !== undefined) {
			clearTimeout(pollTimer);
			pollTimer = undefined;
		}

		clearReleaseTimer();
		update(undefined);
	};
};

export { getAudioLevelFromStats, startLocalVoiceActivityMonitor };
