import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { Encoder } from '@evan/opus';
import { ProtectionProfileAes128CmHmacSha1_80, RtpHeader, SrtpSession } from 'werift-rtp';
import type { TAppAudioRtpTarget } from './types';

export type { TAppAudioRtpTarget };

// Stage 1 native app/system-audio RTP sender (Electron main).
//
// Consumes the sidecar's binary-egress PCM, resamples it onto a fixed 48 kHz
// stereo Opus clock, Opus-encodes 20 ms frames, RTP-packetizes, SRTP-protects
// (AES_CM_128_HMAC_SHA1_80), and UDP-sends to the mediasoup PlainTransport.
//
// The drift fix lives in the resampler: there is no second render clock (unlike
// the renderer worklet), so the only clock crossing is input-rate -> encoder
// rate, absorbed by continuous linear resampling rather than by dropping queued
// chunks.
//
// Pacing is ARRIVAL-PACED (Stage 1): a frame is encoded and sent as soon as
// enough resampled PCM has accumulated, so bursty sidecar PCM produces bursty
// RTP. RTP timestamps still advance by a fixed 960 samples/frame, so the stream
// is timing-correct; only the send cadence is jittery. Stage 2 moves encode into
// the native sidecar where a true fixed-cadence pull belongs. This is acceptable
// for low-bitrate Opus that the SFU + jitter buffers absorb.

export const APP_AUDIO_RTP_CLOCK_RATE = 48_000;
export const APP_AUDIO_RTP_CHANNELS = 2;
export const APP_AUDIO_RTP_PAYLOAD_TYPE = 100;
export const APP_AUDIO_OPUS_FRAME_MS = 20;
export const APP_AUDIO_OPUS_BITRATE_BPS = 96_000;
// 48000 / 1000 * 20 = 960 samples per channel per 20 ms frame.
export const APP_AUDIO_SAMPLES_PER_FRAME = (APP_AUDIO_RTP_CLOCK_RATE / 1_000) * APP_AUDIO_OPUS_FRAME_MS;

// AES_CM_128_HMAC_SHA1_80: 16-byte master key + 14-byte master salt = the 30
// bytes mediasoup expects, base64-encoded, as SrtpParameters.keyBase64.
const SRTP_MASTER_KEY_BYTES = 16;
const SRTP_MASTER_SALT_BYTES = 14;

export type TAppAudioPcmInput = {
	pcm: Float32Array;
	sampleRate: number;
	channels: number;
};

export interface TOpusEncoderLike {
	encode(buf: ArrayBufferView): Uint8Array;
}

export interface TUdpSocketLike {
	send(buf: Buffer, port: number, address: string, callback?: (error?: Error | null) => void): void;
	close(callback?: () => void): void;
}

export type TAppAudioRtpSenderDeps = {
	createEncoder?: () => TOpusEncoderLike;
	createSocket?: (ip: string) => TUdpSocketLike;
};

const clampSampleToInt16 = (sample: number): number => {
	const scaled = Math.round(sample * 0x7fff);

	if (scaled > 0x7fff) return 0x7fff;
	if (scaled < -0x8000) return -0x8000;

	return scaled;
};

// Streaming linear resampler: interleaved input (any rate / 1–N channels) ->
// interleaved 48 kHz stereo. State (fractional position + a carried frame) is
// preserved across calls so frame boundaries do not introduce discontinuities.
export class PcmResampler {
	private readonly outRate: number;
	private readonly outChannels: number;
	private carry = new Float32Array(0);
	private frac = 0;
	private inRate = 0;
	private inChannels = 0;

	constructor(outRate = APP_AUDIO_RTP_CLOCK_RATE, outChannels = APP_AUDIO_RTP_CHANNELS) {
		this.outRate = outRate;
		this.outChannels = outChannels;
	}

	private channelSample(buf: Float32Array, frameIndex: number, outChannel: number, inChannels: number): number {
		if (inChannels === 1) {
			return buf[frameIndex] ?? 0;
		}

		const sourceChannel = outChannel < inChannels ? outChannel : inChannels - 1;

		return buf[frameIndex * inChannels + sourceChannel] ?? 0;
	}

	process(input: TAppAudioPcmInput): Float32Array {
		const { pcm, sampleRate, channels } = input;

		if (sampleRate <= 0 || channels <= 0 || pcm.length === 0) {
			return new Float32Array(0);
		}

		// A mid-stream format change invalidates the carried state.
		if (sampleRate !== this.inRate || channels !== this.inChannels) {
			this.carry = new Float32Array(0);
			this.frac = 0;
			this.inRate = sampleRate;
			this.inChannels = channels;
		}

		const combined =
			this.carry.length === 0
				? pcm
				: (() => {
						const merged = new Float32Array(this.carry.length + pcm.length);
						merged.set(this.carry, 0);
						merged.set(pcm, this.carry.length);
						return merged;
					})();

		const totalFrames = Math.floor(combined.length / channels);
		const step = sampleRate / this.outRate;
		const out: number[] = [];

		let pos = this.frac;

		// Need both floor(pos) and floor(pos)+1 in range to interpolate.
		while (pos + 1 < totalFrames) {
			const i0 = Math.floor(pos);
			const t = pos - i0;

			for (let ch = 0; ch < this.outChannels; ch += 1) {
				const a = this.channelSample(combined, i0, ch, channels);
				const b = this.channelSample(combined, i0 + 1, ch, channels);
				out.push(a + (b - a) * t);
			}

			pos += step;
		}

		const consumed = Math.floor(pos);
		this.frac = pos - consumed;
		this.carry = combined.slice(consumed * channels);

		return Float32Array.from(out);
	}
}

export class AppAudioRtpSender {
	private readonly target: TAppAudioRtpTarget;
	private readonly payloadType: number;
	private readonly masterKey: Buffer;
	private readonly masterSalt: Buffer;
	private readonly srtpSession: SrtpSession;
	private readonly resampler = new PcmResampler();
	private readonly createEncoder: () => TOpusEncoderLike;
	private readonly createSocket: (ip: string) => TUdpSocketLike;

	private encoder: TOpusEncoderLike | undefined;
	private socket: TUdpSocketLike | undefined;
	private started = false;
	private stopped = false;
	// Interleaved 48 kHz stereo samples awaiting a full Opus frame.
	private pending: Float32Array = new Float32Array(0);
	private sequenceNumber = randomBytes(2).readUInt16BE(0);
	private timestamp = randomBytes(4).readUInt32BE(0);

	constructor(target: TAppAudioRtpTarget, deps: TAppAudioRtpSenderDeps = {}) {
		this.target = target;
		this.payloadType = target.payloadType ?? APP_AUDIO_RTP_PAYLOAD_TYPE;

		const keyMaterial = randomBytes(SRTP_MASTER_KEY_BYTES + SRTP_MASTER_SALT_BYTES);
		this.masterKey = keyMaterial.subarray(0, SRTP_MASTER_KEY_BYTES);
		this.masterSalt = keyMaterial.subarray(SRTP_MASTER_KEY_BYTES);
		// Send-only: we encrypt with our local key. The remote key is unused (we
		// never decrypt), so it is set to the same material to satisfy the session.
		this.srtpSession = new SrtpSession({
			profile: ProtectionProfileAes128CmHmacSha1_80,
			keys: {
				localMasterKey: this.masterKey,
				localMasterSalt: this.masterSalt,
				remoteMasterKey: this.masterKey,
				remoteMasterSalt: this.masterSalt,
			},
		});

		this.createEncoder =
			deps.createEncoder ??
			(() => {
				const encoder = new Encoder({
					channels: APP_AUDIO_RTP_CHANNELS,
					sample_rate: APP_AUDIO_RTP_CLOCK_RATE,
					application: 'audio',
				});
				encoder.bitrate = APP_AUDIO_OPUS_BITRATE_BPS;
				encoder.inband_fec = true;

				return encoder;
			});

		this.createSocket = deps.createSocket ?? ((ip: string) => createSocket(ip.includes(':') ? 'udp6' : 'udp4'));
	}

	// The client SRTP keying material handed to the server via produceAppAudio.
	// mediasoup uses it as the remote key to decrypt our RTP.
	getClientSrtpKeyBase64(): string {
		return Buffer.concat([this.masterKey, this.masterSalt]).toString('base64');
	}

	start(): void {
		if (this.started) {
			return;
		}

		this.started = true;
		this.encoder = this.createEncoder();
		this.socket = this.createSocket(this.target.ip);
	}

	pushPcm(input: TAppAudioPcmInput): void {
		if (!this.started || this.stopped || !this.encoder || !this.socket) {
			return;
		}

		const resampled = this.resampler.process(input);

		if (resampled.length === 0 && this.pending.length === 0) {
			return;
		}

		if (resampled.length > 0) {
			const merged = new Float32Array(this.pending.length + resampled.length);
			merged.set(this.pending, 0);
			merged.set(resampled, this.pending.length);
			this.pending = merged;
		}

		const samplesPerFrame = APP_AUDIO_SAMPLES_PER_FRAME * APP_AUDIO_RTP_CHANNELS;

		let offset = 0;
		while (this.pending.length - offset >= samplesPerFrame) {
			const frame = this.pending.subarray(offset, offset + samplesPerFrame);
			this.encodeAndSend(frame);
			offset += samplesPerFrame;
		}

		this.pending = offset === 0 ? this.pending : this.pending.slice(offset);
	}

	private encodeAndSend(frame: Float32Array): void {
		const encoder = this.encoder;
		const socket = this.socket;

		if (!encoder || !socket) {
			return;
		}

		const pcm16 = new Int16Array(frame.length);
		for (let index = 0; index < frame.length; index += 1) {
			pcm16[index] = clampSampleToInt16(frame[index] ?? 0);
		}

		let opusPayload: Uint8Array;
		try {
			opusPayload = encoder.encode(pcm16);
		} catch (error) {
			console.warn('[desktop] Opus encode failed for app-audio RTP frame', error);
			return;
		}

		const header = new RtpHeader({
			version: 2,
			padding: false,
			extension: false,
			marker: false,
			payloadType: this.payloadType,
			sequenceNumber: this.sequenceNumber,
			timestamp: this.timestamp,
			ssrc: this.target.ssrc,
		});

		const protectedPacket = this.srtpSession.encrypt(Buffer.from(opusPayload), header);

		socket.send(protectedPacket, this.target.port, this.target.ip, (error) => {
			if (error) {
				console.warn('[desktop] Failed to send app-audio RTP packet', error);
			}
		});

		this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
		this.timestamp = (this.timestamp + APP_AUDIO_SAMPLES_PER_FRAME) >>> 0;
	}

	stop(): void {
		if (this.stopped) {
			return;
		}

		this.stopped = true;
		this.pending = new Float32Array(0);

		const socket = this.socket;
		this.socket = undefined;
		this.encoder = undefined;

		if (socket) {
			try {
				socket.close();
			} catch {
				// ignore — socket may already be closed
			}
		}
	}
}
