import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ProtectionProfileAes128CmHmacSha1_80, RtpHeader, SrtpSession } from 'werift-rtp';
import {
	APP_AUDIO_RTP_PAYLOAD_TYPE,
	AppAudioRtpSender,
	PcmResampler,
	type TOpusEncoderLike,
	type TUdpSocketLike,
} from '../app-audio-rtp-sender';

const makeFakeEncoder = (payload: Uint8Array): TOpusEncoderLike => ({
	encode: () => payload,
});

type TCapturedPacket = { buffer: Buffer; port: number; address: string };

const makeFakeSocket = (captured: TCapturedPacket[]): TUdpSocketLike => ({
	send: (buffer, port, address, callback) => {
		captured.push({ buffer, port, address });
		callback?.(null);
	},
	close: () => {},
});

describe('PcmResampler', () => {
	test('upsamples toward the output frame count within tolerance', () => {
		const resampler = new PcmResampler(48_000, 2);

		// 24 kHz mono input over several chunks -> ~2x the frames at 48 kHz stereo.
		const inputFramesPerChunk = 480;
		const chunks = 10;
		let outputFrames = 0;

		for (let chunk = 0; chunk < chunks; chunk += 1) {
			const input = new Float32Array(inputFramesPerChunk);
			for (let i = 0; i < input.length; i += 1) {
				input[i] = Math.sin(i / 10);
			}

			const out = resampler.process({ pcm: input, sampleRate: 24_000, channels: 1 });
			outputFrames += out.length / 2;
		}

		const expectedFrames = (inputFramesPerChunk * chunks * 48_000) / 24_000;
		const drift = Math.abs(outputFrames - expectedFrames);

		// Allow a few frames of boundary slack carried across chunks.
		assert.ok(drift <= chunks + 2, `resampler drift ${drift} exceeded tolerance`);
	});

	test('passes through a matching rate close to 1:1', () => {
		const resampler = new PcmResampler(48_000, 2);
		const input = new Float32Array(4_000); // 2000 stereo frames
		const out = resampler.process({ pcm: input, sampleRate: 48_000, channels: 2 });

		const outFrames = out.length / 2;
		assert.ok(Math.abs(outFrames - 2_000) <= 2, `expected ~2000 frames, got ${outFrames}`);
	});
});

describe('AppAudioRtpSender', () => {
	test('emits a well-formed, decryptable SRTP packet for the target ssrc and payload type', async () => {
		const captured: TCapturedPacket[] = [];
		const opusPayload = new Uint8Array([10, 20, 30, 40, 50]);
		const target = { ip: '203.0.113.7', port: 40_100, ssrc: 0x11223344 };

		const sender = new AppAudioRtpSender(target, {
			createEncoder: () => makeFakeEncoder(opusPayload),
			createSocket: () => makeFakeSocket(captured),
		});

		await sender.start();

		// 2000 stereo frames at 48 kHz -> at least one full 960-sample frame.
		sender.pushPcm({ pcm: new Float32Array(2_000 * 2), sampleRate: 48_000, channels: 2 });

		assert.ok(captured.length >= 1, 'expected at least one RTP packet to be sent');

		const packet = captured[0]!;
		assert.equal(packet.port, target.port);
		assert.equal(packet.address, target.ip);

		const header = RtpHeader.deSerialize(packet.buffer);
		assert.equal(header.version, 2);
		assert.equal(header.payloadType, APP_AUDIO_RTP_PAYLOAD_TYPE);
		assert.equal(header.ssrc, target.ssrc);

		// Decrypt with the same keying material the sender handed to the server.
		const keyMaterial = Buffer.from(sender.getClientSrtpKeyBase64(), 'base64');
		const masterKey = keyMaterial.subarray(0, 16);
		const masterSalt = keyMaterial.subarray(16);
		const decryptSession = new SrtpSession({
			profile: ProtectionProfileAes128CmHmacSha1_80,
			keys: {
				localMasterKey: masterKey,
				localMasterSalt: masterSalt,
				remoteMasterKey: masterKey,
				remoteMasterSalt: masterSalt,
			},
		});

		// decrypt() returns the full decrypted RTP packet (header + payload); the
		// Opus payload is the tail after the RTP header.
		const decrypted = new Uint8Array(decryptSession.decrypt(packet.buffer));
		const decryptedPayload = decrypted.subarray(decrypted.length - opusPayload.length);
		assert.deepEqual(decryptedPayload, opusPayload);
	});

	test('the client SRTP key is 30 bytes (16-byte key + 14-byte salt)', () => {
		const sender = new AppAudioRtpSender(
			{ ip: '127.0.0.1', port: 5_000, ssrc: 1 },
			{ createEncoder: () => makeFakeEncoder(new Uint8Array([1])), createSocket: () => makeFakeSocket([]) },
		);

		const keyBytes = Buffer.from(sender.getClientSrtpKeyBase64(), 'base64');
		assert.equal(keyBytes.length, 30);
	});

	test('pushPcm before start is a no-op', () => {
		const captured: TCapturedPacket[] = [];
		const sender = new AppAudioRtpSender(
			{ ip: '127.0.0.1', port: 5_000, ssrc: 1 },
			{ createEncoder: () => makeFakeEncoder(new Uint8Array([1])), createSocket: () => makeFakeSocket(captured) },
		);

		sender.pushPcm({ pcm: new Float32Array(2_000 * 2), sampleRate: 48_000, channels: 2 });
		assert.equal(captured.length, 0);
	});

	test('sequence number increments across frames', async () => {
		const captured: TCapturedPacket[] = [];
		const sender = new AppAudioRtpSender(
			{ ip: '127.0.0.1', port: 5_000, ssrc: 7 },
			{ createEncoder: () => makeFakeEncoder(new Uint8Array([1, 2])), createSocket: () => makeFakeSocket(captured) },
		);

		await sender.start();
		// Enough for several 960-sample frames.
		sender.pushPcm({ pcm: new Float32Array(5_000 * 2), sampleRate: 48_000, channels: 2 });

		assert.ok(captured.length >= 2, 'expected multiple packets');
		const seq0 = RtpHeader.deSerialize(captured[0]!.buffer).sequenceNumber;
		const seq1 = RtpHeader.deSerialize(captured[1]!.buffer).sequenceNumber;
		assert.equal(seq1, (seq0 + 1) & 0xffff);
	});

	test('encoder load failures reject start without opening the UDP socket', async () => {
		let socketCreated = false;
		const sender = new AppAudioRtpSender(
			{ ip: '127.0.0.1', port: 5_000, ssrc: 7 },
			{
				createEncoder: async () => {
					throw new Error('opus unavailable');
				},
				createSocket: () => {
					socketCreated = true;
					return makeFakeSocket([]);
				},
			},
		);

		await assert.rejects(sender.start(), /opus unavailable/);
		assert.equal(socketCreated, false);
	});
});
