import { describe, expect, test } from 'bun:test';
import { isAuxiliaryVideoCodec } from '../hooks/use-transport-stats';

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
