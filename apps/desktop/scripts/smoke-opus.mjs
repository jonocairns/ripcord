// Smoke test for the native app-audio Opus encoder (@evan/opus).
//
// Stage 1 native RTP ingest depends on @evan/opus loading a per-platform
// .node/.wasm at runtime. Dev/CI loading it is NOT sufficient evidence that a
// PACKAGED build can — the encoder is externalized from the tsup bundle and
// asar-unpacked by electron-builder, and a packaging misconfig fails silently
// (native ingest just falls back to the worklet). Run this against the packaged
// app's node_modules to prove encoder creation + one encode actually work.
//
// Usage:
//   node apps/desktop/scripts/smoke-opus.mjs
//   OPUS_FORCE_WASM=1 node apps/desktop/scripts/smoke-opus.mjs   # force the WASM path
//
// In a packaged app, run with the unpacked resources on the module path, e.g.:
//   node --experimental-default-type=module \
//     -e "import('<app>/resources/app.asar.unpacked/node_modules/@evan/opus/lib.js')..."
// or simply run this file with cwd inside the packaged resources directory.

const FRAME_SAMPLES_PER_CHANNEL = 960; // 20 ms @ 48 kHz
const CHANNELS = 2;

const main = async () => {
	const { Encoder } = await import('@evan/opus');

	const encoder = new Encoder({ channels: CHANNELS, sample_rate: 48_000, application: 'audio' });
	encoder.bitrate = 96_000;
	encoder.inband_fec = true;

	// One 20 ms stereo frame of interleaved Int16 silence.
	const pcm = new Int16Array(FRAME_SAMPLES_PER_CHANNEL * CHANNELS);
	const encoded = encoder.encode(pcm);

	if (!(encoded instanceof Uint8Array) || encoded.length === 0) {
		throw new Error(`Opus encode produced no output (got ${encoded?.length ?? 'undefined'} bytes)`);
	}

	const backend = process.env.OPUS_FORCE_WASM ? 'wasm (forced)' : 'native-or-wasm (auto)';
	console.log(`[smoke-opus] OK — backend=${backend}, encoded ${encoded.length} bytes from a 20ms stereo frame`);
};

main().catch((error) => {
	console.error('[smoke-opus] FAILED —', error);
	process.exit(1);
});
