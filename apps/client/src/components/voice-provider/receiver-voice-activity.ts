import type { VoiceActivity } from './voice-activity';
import { EMPTY_VOICE_ACTIVITY } from './voice-activity';

// Remote-user level metering via RTCRtpReceiver.getSynchronizationSources().
// Avoids creating a MediaStreamAudioSourceNode on a WebRTC remote track, which
// causes a known Chromium/Electron static artifact modulated by speech when the
// same track is also attached to an HTMLAudioElement for playback.
const SPEAKING_THRESHOLD = 8;
const AUDIO_LEVEL_POLL_INTERVAL_MS = 50;
// Bucket size for level updates; increase (e.g. 5) to coalesce micro-changes.
const AUDIO_LEVEL_PRECISION = 1;
// A synchronization source entry is only considered recent if its timestamp is
// within this window; older entries are treated as silence.
const SSRC_FRESHNESS_WINDOW_MS = 200;

const startReceiverVoiceActivityMonitor = (
	receiver: RTCRtpReceiver,
	onUpdate: (activity: VoiceActivity) => void,
): (() => void) => {
	onUpdate(EMPTY_VOICE_ACTIVITY);

	if (typeof receiver.getSynchronizationSources !== 'function') {
		return () => undefined;
	}

	let cancelled = false;
	let timeoutId: number | null = null;
	let previousActivity = EMPTY_VOICE_ACTIVITY;

	const sample = () => {
		if (cancelled) {
			return;
		}

		let audioLevel = 0;

		try {
			const sources = receiver.getSynchronizationSources();
			// `RTCRtpContributingSource.timestamp` is epoch-relative
			// (performance.timeOrigin + performance.now()), so compare against
			// Date.now() — not performance.now() — or the freshness guard never fires.
			const now = Date.now();

			for (const source of sources) {
				if (typeof source.audioLevel !== 'number') {
					continue;
				}

				if (typeof source.timestamp === 'number' && now - source.timestamp > SSRC_FRESHNESS_WINDOW_MS) {
					continue;
				}

				if (source.audioLevel > audioLevel) {
					audioLevel = source.audioLevel;
				}
			}
		} catch {
			// Swallow; fall through to reporting silence for this tick.
		}

		const normalizedLevel = Math.min(100, audioLevel * 100);
		const roundedLevel = Math.round(normalizedLevel / AUDIO_LEVEL_PRECISION) * AUDIO_LEVEL_PRECISION;
		const nextActivity = {
			audioLevel: roundedLevel,
			isSpeaking: roundedLevel > SPEAKING_THRESHOLD,
		};

		if (
			nextActivity.audioLevel !== previousActivity.audioLevel ||
			nextActivity.isSpeaking !== previousActivity.isSpeaking
		) {
			previousActivity = nextActivity;
			onUpdate(nextActivity);
		}

		timeoutId = window.setTimeout(sample, AUDIO_LEVEL_POLL_INTERVAL_MS);
	};

	sample();

	return () => {
		cancelled = true;

		if (timeoutId !== null) {
			window.clearTimeout(timeoutId);
			timeoutId = null;
		}

		onUpdate(EMPTY_VOICE_ACTIVITY);
	};
};

export { startReceiverVoiceActivityMonitor };
