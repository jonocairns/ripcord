import { describe, expect, it } from 'bun:test';
import { getAudioOpusConfig } from '../audio-producer-config';

describe('channel Opus configuration', () => {
	it.each([
		undefined,
		{ voiceBitrate: null, voiceDtx: null },
	])('uses voice defaults for missing settings: %j', (settings) => {
		expect(getAudioOpusConfig(settings)).toEqual({
			maxBitrate: 96_000,
			codecOptions: { opusMaxAverageBitrate: 96_000, opusDtx: false },
		});
	});

	it('applies channel bitrate and DTX overrides together', () => {
		expect(getAudioOpusConfig({ voiceBitrate: 128_000, voiceDtx: true })).toEqual({
			maxBitrate: 128_000,
			codecOptions: { opusMaxAverageBitrate: 128_000, opusDtx: true },
		});
	});

	it('defaults bitrate independently of a DTX override', () => {
		expect(getAudioOpusConfig({ voiceBitrate: null, voiceDtx: true })).toEqual({
			maxBitrate: 96_000,
			codecOptions: { opusMaxAverageBitrate: 96_000, opusDtx: true },
		});
	});

	it('defaults DTX independently of a bitrate override', () => {
		expect(getAudioOpusConfig({ voiceBitrate: 64_000, voiceDtx: null })).toEqual({
			maxBitrate: 64_000,
			codecOptions: { opusMaxAverageBitrate: 64_000, opusDtx: false },
		});
	});

	it('preserves explicit false and zero settings rather than treating them as missing', () => {
		expect(getAudioOpusConfig({ voiceBitrate: 0, voiceDtx: false })).toEqual({
			maxBitrate: 0,
			codecOptions: { opusMaxAverageBitrate: 0, opusDtx: false },
		});
	});
});
