import { describe, expect, it } from 'bun:test';
import { decodePcmBase64 } from '../desktop-app-audio-pcm';

const encodeFloat32ToBase64 = (values: number[]): string => {
	const floats = new Float32Array(values);
	const bytes = new Uint8Array(floats.buffer);
	let binary = '';
	for (let index = 0; index < bytes.length; index += 1) {
		binary += String.fromCharCode(bytes[index]);
	}
	return btoa(binary);
};

describe('decodePcmBase64', () => {
	it('round-trips a valid Float32 PCM payload', () => {
		const values = [0.1, -0.5, 0.25, -1, 1];
		const decoded = decodePcmBase64(encodeFloat32ToBase64(values));

		expect(decoded).toBeDefined();
		expect(Array.from(decoded as Float32Array)).toEqual(Array.from(new Float32Array(values)));
	});

	it('decodes an empty payload to an empty array', () => {
		const decoded = decodePcmBase64('');

		expect(decoded).toBeDefined();
		expect((decoded as Float32Array).length).toBe(0);
	});

	it('returns undefined for a byte length that is not a multiple of 4', () => {
		// Five raw bytes cannot back a Float32Array.
		const base64 = btoa('\x00\x01\x02\x03\x04');

		expect(decodePcmBase64(base64)).toBeUndefined();
	});

	it('returns undefined for invalid base64 input', () => {
		expect(decodePcmBase64('@@not-base64@@')).toBeUndefined();
	});
});
