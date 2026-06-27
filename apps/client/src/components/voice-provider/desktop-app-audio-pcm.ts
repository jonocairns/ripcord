// Decodes a base64-encoded little-endian Float32 PCM payload.
//
// Returns undefined for an undecodable payload (invalid base64, or a byte length
// that is not a multiple of 4 so cannot back a Float32Array) so callers can drop
// the frame gracefully instead of throwing out of the frame handler.
const decodePcmBase64 = (pcmBase64: string): Float32Array | undefined => {
	try {
		const binaryString = atob(pcmBase64);
		const byteLength = binaryString.length;

		if (byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
			return undefined;
		}

		const bytes = new Uint8Array(byteLength);

		for (let index = 0; index < byteLength; index += 1) {
			bytes[index] = binaryString.charCodeAt(index);
		}

		return new Float32Array(bytes.buffer);
	} catch {
		return undefined;
	}
};

export { decodePcmBase64 };
