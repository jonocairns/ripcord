import { describe, expect, test } from 'bun:test';
import { isAuxiliaryVideoCodec, isAuxiliaryVideoStat } from '../hooks/use-transport-stats';

describe('isAuxiliaryVideoCodec', () => {
	test('identifies RTX codec records', () => {
		expect(isAuxiliaryVideoCodec('rtx')).toBe(true);
		expect(isAuxiliaryVideoCodec('RTX')).toBe(true);
	});

	test('keeps primary video codecs', () => {
		expect(isAuxiliaryVideoCodec('H264')).toBe(false);
		expect(isAuxiliaryVideoCodec('VP8')).toBe(false);
		expect(isAuxiliaryVideoCodec('VP9')).toBe(false);
		expect(isAuxiliaryVideoCodec(null)).toBe(false);
	});
});

describe('isAuxiliaryVideoStat', () => {
	test('drops RTX records regardless of media activity', () => {
		expect(isAuxiliaryVideoStat('rtx', { frameWidth: 1920, frameHeight: 1080 })).toBe(true);
	});

	test('drops unknown-codec records carrying no frame activity (RTX without codecId)', () => {
		expect(isAuxiliaryVideoStat(null, {})).toBe(true);
		expect(isAuxiliaryVideoStat(null, { frameWidth: 0, framesDecoded: 0 })).toBe(true);
	});

	test('keeps unknown-codec records that report real media', () => {
		expect(isAuxiliaryVideoStat(null, { frameWidth: 1920, frameHeight: 1080 })).toBe(false);
		expect(isAuxiliaryVideoStat(null, { framesDecoded: 5 })).toBe(false);
		expect(isAuxiliaryVideoStat(null, { framesReceived: 5 })).toBe(false);
	});

	test('keeps primary codec streams even before first frame', () => {
		expect(isAuxiliaryVideoStat('H264', {})).toBe(false);
		expect(isAuxiliaryVideoStat('VP9', { frameWidth: 0 })).toBe(false);
	});
});
