import { logVoice } from '@/helpers/browser-logger';

let hasPrewarmedWebRtcEngine = false;
let hasAttemptedMicrophonePrewarm = false;

// The first RTCPeerConnection on a fresh renderer spins up Chromium's entire
// WebRTC engine (~900ms cold). mediasoup's device.load() pays this because it
// probes native RTP capabilities via a throwaway peer connection + createOffer.
// Do the same here once, up front, so the first real device.load() is warm.
const warmWebRtcEngine = async (): Promise<void> => {
	let pc: RTCPeerConnection | undefined;

	try {
		pc = new RTCPeerConnection();
		pc.addTransceiver('audio', { direction: 'recvonly' });
		pc.addTransceiver('video', { direction: 'recvonly' });
		await pc.createOffer();
	} catch (error) {
		logVoice('[prewarm] WebRTC engine warm-up failed', { error });
	} finally {
		pc?.close();
	}
};

// The first getUserMedia initializes Chromium's audio-capture subsystem
// (~950ms cold). Acquire a mic stream briefly and stop it immediately so the
// first real acquisition on join is warm. This briefly activates the OS mic
// indicator, which is why the caller restricts it to the desktop app.
const warmMicrophone = async (): Promise<void> => {
	let stream: MediaStream | undefined;

	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
	} catch (error) {
		logVoice('[prewarm] Microphone warm-up failed', { error });
	} finally {
		stream?.getTracks().forEach((track) => {
			track.stop();
		});
	}
};

const getMicrophonePermissionState = async (): Promise<PermissionState | undefined> => {
	if (!navigator.permissions?.query) {
		return undefined;
	}

	try {
		const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
		return status.state;
	} catch (error) {
		logVoice('[prewarm] Microphone permission check failed', { error });
		return undefined;
	}
};

// Warm the heavy one-time WebRTC + audio-capture initializations so the first
// voice join is fast instead of paying ~1s of cold-start. Runs once per page session.
const prewarmVoiceEngines = (opts: { warmMicrophoneIfGranted?: boolean } = {}): void => {
	if (hasPrewarmedWebRtcEngine && (!opts.warmMicrophoneIfGranted || hasAttemptedMicrophonePrewarm)) {
		return;
	}

	void (async () => {
		const startedAt = performance.now();
		const tasks: Promise<void>[] = [];

		if (!hasPrewarmedWebRtcEngine) {
			hasPrewarmedWebRtcEngine = true;
			tasks.push(warmWebRtcEngine());
		}

		if (opts.warmMicrophoneIfGranted && !hasAttemptedMicrophonePrewarm) {
			hasAttemptedMicrophonePrewarm = true;
			tasks.push(
				(async () => {
					if ((await getMicrophonePermissionState()) !== 'granted') {
						return;
					}

					await warmMicrophone();
				})(),
			);
		}

		await Promise.allSettled(tasks);
		logVoice('[prewarm] Voice engines warmed', { ms: Math.round(performance.now() - startedAt) });
	})();
};

export { prewarmVoiceEngines };
