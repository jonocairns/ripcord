import { getPublicAssetUrl } from '@/helpers/get-file-url';
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

const createGain = (value = 1) => {
	const gain = audioCtx.createGain();

	gain.gain.setValueAtTime(value * SOUNDS_VOLUME, now());

	return gain;
};

type TSoundAssetConfig = {
	url: string;
	volume?: number;
};

const createSoundAssetUrl = (fileName: string): string => {
	return getPublicAssetUrl(`sounds/${fileName}`, { absolute: true });
};

const soundAssets: Partial<Record<SoundType, TSoundAssetConfig>> = {
	[SoundType.MESSAGE_RECEIVED]: {
		url: createSoundAssetUrl('message1.mp3'),
		volume: 0.2,
	},
	[SoundType.SERVER_DISCONNECTED]: {
		url: createSoundAssetUrl('disconnect.mp3'),
		volume: 0.2,
	},
	[SoundType.OWN_USER_LEFT_VOICE_CHANNEL]: {
		url: createSoundAssetUrl('user_leave.mp3'),
		volume: 0.2,
	},
	[SoundType.OWN_USER_JOINED_VOICE_CHANNEL]: {
		url: createSoundAssetUrl('user_join.mp3'),
		volume: 0.2,
	},
	[SoundType.OWN_USER_MUTED_MIC]: {
		url: createSoundAssetUrl('mute.mp3'),
		volume: 0.2,
	},
	[SoundType.OWN_USER_UNMUTED_MIC]: {
		url: createSoundAssetUrl('unmute.mp3'),
		volume: 0.2,
	},
	[SoundType.OWN_USER_MUTED_SOUND]: {
		url: createSoundAssetUrl('deafen.mp3'),
		volume: 0.2,
	},
	[SoundType.OWN_USER_UNMUTED_SOUND]: {
		url: createSoundAssetUrl('undeafen.mp3'),
		volume: 0.2,
	},
	[SoundType.OWN_USER_STARTED_WEBCAM]: {
		url: createSoundAssetUrl('stream_started.mp3'),
		volume: 0.2,
	},
	[SoundType.OWN_USER_STOPPED_WEBCAM]: {
		url: createSoundAssetUrl('stream_ended.mp3'),
		volume: 0.2,
	},
	[SoundType.OWN_USER_STARTED_SCREENSHARE]: {
		url: createSoundAssetUrl('stream_started.mp3'),
		volume: 0.2,
	},
	[SoundType.OWN_USER_STOPPED_SCREENSHARE]: {
		url: createSoundAssetUrl('stream_ended.mp3'),
		volume: 0.2,
	},
	[SoundType.REMOTE_USER_STARTED_STREAM]: {
		url: createSoundAssetUrl('stream_started.mp3'),
		volume: 0.2,
	},
	[SoundType.STREAM_WATCHER_JOINED]: {
		url: createSoundAssetUrl('stream_user_joined.mp3'),
		volume: 0.2,
	},
	[SoundType.STREAM_WATCHER_LEFT]: {
		url: createSoundAssetUrl('stream_user_left.mp3'),
		volume: 0.2,
	},
	[SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL]: {
		url: createSoundAssetUrl('user_join.mp3'),
		volume: 0.2,
	},
	[SoundType.REMOTE_USER_LEFT_VOICE_CHANNEL]: {
		url: createSoundAssetUrl('user_leave.mp3'),
		volume: 0.2,
	},
};

const soundBufferCache = new Map<string, Promise<AudioBuffer>>();

const loadSoundBuffer = (url: string): Promise<AudioBuffer> => {
	const existing = soundBufferCache.get(url);

	if (existing) {
		return existing;
	}

	const pending = fetch(url)
		.then(async (response) => {
			if (!response.ok) {
				throw new Error(`Failed to fetch sound asset: ${url}`);
			}

			return response.arrayBuffer();
		})
		.then((buffer) => audioCtx.decodeAudioData(buffer.slice(0)));

	soundBufferCache.set(url, pending);

	return pending;
};

const playBufferedSound = (config: TSoundAssetConfig): Promise<void> => {
	return loadSoundBuffer(config.url).then((buffer) => {
		const source = audioCtx.createBufferSource();
		const gain = createGain(config.volume ?? 1);

		source.buffer = buffer;
		source.connect(gain).connect(masterGain);
		source.start();
	});
};
const playSoundEffect = (type: SoundType) => {
	const soundAsset = soundAssets[type];

	if (!soundAsset) {
		return;
	}

	void playBufferedSound(soundAsset).catch(() => {
		// Ignore asset failures and avoid falling back to synthetic cues.
	});
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
