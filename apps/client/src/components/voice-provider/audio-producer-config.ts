import type { TPublicChannel } from '@sharkord/shared';

const DEFAULT_AUDIO_OPUS_TARGET_BITRATE_BPS = 96_000;
// Desktop/game audio is music-grade, full-band content (not voice), so it gets
// stereo, high-bitrate opus with FEC on and DTX off — DTX gates "silence" and
// audibly clips sustained music.
const SCREEN_SHARE_AUDIO_TARGET_BITRATE_BPS = 256_000;

const getAudioOpusConfig = (channelSettings: Pick<TPublicChannel, 'voiceBitrate' | 'voiceDtx'> | undefined) => {
	const bitrate = channelSettings?.voiceBitrate ?? DEFAULT_AUDIO_OPUS_TARGET_BITRATE_BPS;
	const dtx = channelSettings?.voiceDtx ?? false;

	return {
		maxBitrate: bitrate,
		codecOptions: {
			opusMaxAverageBitrate: bitrate,
			opusDtx: dtx,
		},
	};
};

const getScreenShareAudioOpusConfig = () => ({
	codecOptions: {
		opusStereo: true,
		opusFec: true,
		opusDtx: false,
		opusMaxAverageBitrate: SCREEN_SHARE_AUDIO_TARGET_BITRATE_BPS,
	},
});

export { getAudioOpusConfig, getScreenShareAudioOpusConfig };
