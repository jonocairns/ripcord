import { SoundType } from '../types';

const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();

const SOUNDS_VOLUME = 4;

const masterGain = audioCtx.createGain();
masterGain.gain.setValueAtTime(1, 0);

const limiter = audioCtx.createDynamicsCompressor();
limiter.threshold.setValueAtTime(-1, 0);
limiter.knee.setValueAtTime(0, 0);
limiter.ratio.setValueAtTime(20, 0);
limiter.attack.setValueAtTime(0.001, 0);
limiter.release.setValueAtTime(0.05, 0);

masterGain.connect(limiter).connect(audioCtx.destination);

// Play a short silent buffer to prime the audio pipeline. Without this,
// the first real sound after the context starts (or wakes from idle)
// produces a brief click/static as the rendering thread spins up and the
// compressor reacts to a sudden signal.
const warmUpAudioContext = () => {
	const buf = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
	const src = audioCtx.createBufferSource();

	src.buffer = buf;
	src.connect(masterGain);
	src.start();
};

const now = () => audioCtx.currentTime;

const createOsc = (type: OscillatorType, freq: number) => {
	const osc = audioCtx.createOscillator();

	osc.type = type;
	osc.frequency.setValueAtTime(freq, now());

	return osc;
};

const createGain = (value = 1) => {
	const gain = audioCtx.createGain();

	gain.gain.setValueAtTime(value * SOUNDS_VOLUME, now());

	return gain;
};

const createVoiceCueFilter = () => {
	const filter = audioCtx.createBiquadFilter();

	filter.type = 'lowpass';
	filter.frequency.setValueAtTime(950, now());
	filter.Q.setValueAtTime(0.45, now());

	return filter;
};

type TSoundCueTone = {
	type: OscillatorType;
	freq: number;
	gain: number;
	delay: number;
	duration: number;
};

const playToneSequence = (tones: TSoundCueTone[]) => {
	tones.forEach(({ type, freq, gain: toneGain, delay, duration }) => {
		const t = now() + delay;
		const osc = createOsc(type, freq);
		const gain = createGain(toneGain);
		const filter = createVoiceCueFilter();
		const peakGain = gain.gain.value;
		const attack = Math.min(0.016, duration * 0.28);

		filter.frequency.setValueAtTime(950, t);
		filter.frequency.exponentialRampToValueAtTime(720, t + duration);
		gain.gain.setValueAtTime(0.0001, t);
		gain.gain.exponentialRampToValueAtTime(peakGain, t + attack);
		gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

		osc.connect(gain).connect(filter).connect(masterGain);
		osc.start(t);
		osc.stop(t + duration);
	});
};

// MESSAGE_RECEIVED — ultra-minimal single tone
const sfxMessageReceived = () => {
	const osc = createOsc('sine', 600);
	const gain = createGain(0.05);

	gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.05);

	osc.connect(gain).connect(masterGain);
	osc.start();
	osc.stop(now() + 0.05);
};

// MESSAGE_SENT — ultra-minimal single tone (slightly higher)
const sfxMessageSent = () => {
	const osc = createOsc('sine', 750);
	const gain = createGain(0.04);

	gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.04);

	osc.connect(gain).connect(masterGain);
	osc.start();
	osc.stop(now() + 0.04);
};

// SERVER_DISCONNECTED — short descending alert
const sfxServerDisconnected = () => {
	const tones = [
		{ freq: 880, gain: 0.06, delay: 0 },
		{ freq: 659, gain: 0.05, delay: 0.08 },
		{ freq: 494, gain: 0.04, delay: 0.16 },
	];

	tones.forEach(({ freq, gain: g, delay }) => {
		const t = now() + delay;
		const osc = createOsc('triangle', freq);
		const gain = createGain(g);

		gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);

		osc.connect(gain).connect(masterGain);
		osc.start(t);
		osc.stop(t + 0.18);
	});
};

// OWN_USER_JOINED_VOICE_CHANNEL — short three-note rise
const sfxOwnUserJoinedVoiceChannel = () => {
	playToneSequence([
		{ type: 'sine', freq: 440, gain: 0.03, delay: 0, duration: 0.055 },
		{ type: 'sine', freq: 523.25, gain: 0.028, delay: 0.065, duration: 0.06 },
		{ type: 'sine', freq: 622.25, gain: 0.032, delay: 0.14, duration: 0.085 },
	]);
};

// OWN_USER_LEFT_VOICE_CHANNEL — short three-note fall
const sfxOwnUserLeftVoiceChannel = () => {
	playToneSequence([
		{ type: 'sine', freq: 622.25, gain: 0.03, delay: 0, duration: 0.065 },
		{ type: 'sine', freq: 523.25, gain: 0.026, delay: 0.075, duration: 0.06 },
		{ type: 'sine', freq: 440, gain: 0.024, delay: 0.145, duration: 0.075 },
	]);
};

// MUTED_MIC — extremely bland low click
const sfxOwnUserMutedMic = () => {
	const osc = createOsc('sine', 350);
	const gain = createGain(0.05);

	gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.06);

	osc.connect(gain).connect(masterGain);
	osc.start();
	osc.stop(now() + 0.06);
};

// UNMUTED_MIC — extremely bland slightly higher click
const sfxOwnUserUnmutedMic = () => {
	const osc = createOsc('sine', 500);
	const gain = createGain(0.05);

	gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.06);

	osc.connect(gain).connect(masterGain);
	osc.start();
	osc.stop(now() + 0.06);
};

// MUTED_SOUND — bland mid-low tone
const sfxOwnUserMutedSound = () => {
	const osc = createOsc('sine', 450);
	const gain = createGain(0.05);

	gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.06);

	osc.connect(gain).connect(masterGain);
	osc.start();
	osc.stop(now() + 0.06);
};

// UNMUTED_SOUND — bland mid-high tone
const sfxOwnUserUnmutedSound = () => {
	const osc = createOsc('sine', 650);
	const gain = createGain(0.05);

	gain.gain.exponentialRampToValueAtTime(0.0001, now() + 0.06);

	osc.connect(gain).connect(masterGain);
	osc.start();
	osc.stop(now() + 0.06);
};

// STARTED_WEBCAM — subtle layered activation
const sfxOwnUserStartedWebcam = () => {
	const osc1 = createOsc('sine', 700);
	const gain1 = createGain(0.07);

	gain1.gain.exponentialRampToValueAtTime(0.0001, now() + 0.12);

	osc1.connect(gain1).connect(masterGain);
	osc1.start();
	osc1.stop(now() + 0.12);

	const osc2 = createOsc('sine', 900);
	const gain2 = createGain(0.04);

	gain2.gain.exponentialRampToValueAtTime(0.0001, now() + 0.1);

	osc2.connect(gain2).connect(masterGain);
	osc2.start(now() + 0.04);
	osc2.stop(now() + 0.12);
};

// STOPPED_WEBCAM — subtle layered deactivation
const sfxOwnUserStoppedWebcam = () => {
	const osc1 = createOsc('sine', 700);
	const gain1 = createGain(0.07);

	osc1.frequency.exponentialRampToValueAtTime(500, now() + 0.12);
	gain1.gain.exponentialRampToValueAtTime(0.0001, now() + 0.14);

	osc1.connect(gain1).connect(masterGain);
	osc1.start();
	osc1.stop(now() + 0.14);
};

// STARTED_SCREENSHARE — richer activation sequence
const sfxOwnUserStartedScreenshare = () => {
	// Main pulse sequence — taper gain as freq rises for a natural feel
	const pulses = [
		{ freq: 600, gain: 0.08, delay: 0 },
		{ freq: 800, gain: 0.065, delay: 0.06 },
		{ freq: 1000, gain: 0.05, delay: 0.12 },
	];

	pulses.forEach(({ freq, gain: g, delay }) => {
		const t = now() + delay;
		const osc = createOsc('sine', freq);
		const gain = createGain(g);

		gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);

		osc.connect(gain).connect(masterGain);
		osc.start(t);
		osc.stop(t + 0.1);
	});

	// Harmonic layer
	const osc2 = createOsc('triangle', 1200);
	const gain2 = createGain(0.03);

	gain2.gain.exponentialRampToValueAtTime(0.0001, now() + 0.2);

	osc2.connect(gain2).connect(masterGain);
	osc2.start(now() + 0.08);
	osc2.stop(now() + 0.22);
};

// STOPPED_SCREENSHARE — richer deactivation
const sfxOwnUserStoppedScreenshare = () => {
	const osc1 = createOsc('sine', 900);
	const gain1 = createGain(0.08);

	osc1.frequency.exponentialRampToValueAtTime(550, now() + 0.18);
	gain1.gain.exponentialRampToValueAtTime(0.0001, now() + 0.2);

	osc1.connect(gain1).connect(masterGain);
	osc1.start();
	osc1.stop(now() + 0.2);

	const osc2 = createOsc('triangle', 1100);
	const gain2 = createGain(0.03);

	osc2.frequency.exponentialRampToValueAtTime(700, now() + 0.18);
	gain2.gain.exponentialRampToValueAtTime(0.0001, now() + 0.2);

	osc2.connect(gain2).connect(masterGain);
	osc2.start(now() + 0.05);
	osc2.stop(now() + 0.2);
};

// REMOTE JOIN — compact three-note rise
const sfxRemoteUserJoinedVoiceChannel = () => {
	playToneSequence([
		{ type: 'sine', freq: 440, gain: 0.016, delay: 0, duration: 0.05 },
		{ type: 'sine', freq: 523.25, gain: 0.015, delay: 0.06, duration: 0.05 },
		{ type: 'sine', freq: 622.25, gain: 0.018, delay: 0.13, duration: 0.07 },
	]);
};

// REMOTE STREAM STARTED — compact bright cue
const sfxRemoteUserStartedStream = () => {
	const tones = [
		{ freq: 784, gain: 0.06, delay: 0 }, // G
		{ freq: 988, gain: 0.05, delay: 0.05 }, // B
		{ freq: 1175, gain: 0.035, delay: 0.1 }, // D
	];

	tones.forEach(({ freq, gain: g, delay }) => {
		const t = now() + delay;
		const osc = createOsc('triangle', freq);
		const gain = createGain(g);

		gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

		osc.connect(gain).connect(masterGain);
		osc.start(t);
		osc.stop(t + 0.14);
	});
};

// REMOTE LEAVE — compact three-note fall
const sfxRemoteUserLeftVoiceChannel = () => {
	playToneSequence([
		{ type: 'sine', freq: 622.25, gain: 0.016, delay: 0, duration: 0.055 },
		{ type: 'sine', freq: 523.25, gain: 0.014, delay: 0.065, duration: 0.05 },
		{ type: 'sine', freq: 440, gain: 0.013, delay: 0.13, duration: 0.065 },
	]);
};

// STREAM WATCHER JOINED — light confirmation pulse
const sfxStreamWatcherJoined = () => {
	const tones = [
		{ freq: 659, gain: 0.055, delay: 0 },
		{ freq: 880, gain: 0.045, delay: 0.045 },
	];

	tones.forEach(({ freq, gain: g, delay }) => {
		const t = now() + delay;
		const osc = createOsc('triangle', freq);
		const gain = createGain(g);

		gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

		osc.connect(gain).connect(masterGain);
		osc.start(t);
		osc.stop(t + 0.12);
	});
};

// STREAM WATCHER LEFT — soft descending pulse
const sfxStreamWatcherLeft = () => {
	const tones = [
		{ freq: 740, gain: 0.05, delay: 0 },
		{ freq: 587, gain: 0.04, delay: 0.05 },
	];

	tones.forEach(({ freq, gain: g, delay }) => {
		const t = now() + delay;
		const osc = createOsc('triangle', freq);
		const gain = createGain(g);

		gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

		osc.connect(gain).connect(masterGain);
		osc.start(t);
		osc.stop(t + 0.12);
	});
};

const playSoundEffect = (type: SoundType) => {
	switch (type) {
		case SoundType.MESSAGE_RECEIVED:
			return sfxMessageReceived();
		case SoundType.MESSAGE_SENT:
			return sfxMessageSent();
		case SoundType.SERVER_DISCONNECTED:
			return sfxServerDisconnected();

		case SoundType.OWN_USER_JOINED_VOICE_CHANNEL:
			return sfxOwnUserJoinedVoiceChannel();
		case SoundType.OWN_USER_LEFT_VOICE_CHANNEL:
			return sfxOwnUserLeftVoiceChannel();

		case SoundType.OWN_USER_MUTED_MIC:
			return sfxOwnUserMutedMic();
		case SoundType.OWN_USER_UNMUTED_MIC:
			return sfxOwnUserUnmutedMic();

		case SoundType.OWN_USER_MUTED_SOUND:
			return sfxOwnUserMutedSound();
		case SoundType.OWN_USER_UNMUTED_SOUND:
			return sfxOwnUserUnmutedSound();

		case SoundType.OWN_USER_STARTED_WEBCAM:
			return sfxOwnUserStartedWebcam();
		case SoundType.OWN_USER_STOPPED_WEBCAM:
			return sfxOwnUserStoppedWebcam();

		case SoundType.OWN_USER_STARTED_SCREENSHARE:
			return sfxOwnUserStartedScreenshare();
		case SoundType.OWN_USER_STOPPED_SCREENSHARE:
			return sfxOwnUserStoppedScreenshare();

		case SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL:
			return sfxRemoteUserJoinedVoiceChannel();
		case SoundType.REMOTE_USER_STARTED_STREAM:
			return sfxRemoteUserStartedStream();
		case SoundType.STREAM_WATCHER_JOINED:
			return sfxStreamWatcherJoined();
		case SoundType.STREAM_WATCHER_LEFT:
			return sfxStreamWatcherLeft();
		case SoundType.REMOTE_USER_LEFT_VOICE_CHANNEL:
			return sfxRemoteUserLeftVoiceChannel();

		default:
			return;
	}
};

export const playSound = (type: SoundType) => {
	if (audioCtx.state === 'running') {
		warmUpAudioContext();
		playSoundEffect(type);
		return;
	}

	void audioCtx
		.resume()
		.then(() => {
			warmUpAudioContext();
			playSoundEffect(type);
		})
		.catch(() => {
			// Browser may block resume until a user gesture.
		});
};
