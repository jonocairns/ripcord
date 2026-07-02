/**
 * Authorization tests for the native app-audio ingest routes.
 *
 * SHARE_SCREEN is the app/system-audio authorization boundary. A denial must be
 * hard (FORBIDDEN) on BOTH the native PlainTransport routes and the legacy
 * WebRTC produce path — otherwise a user denied SHARE_SCREEN could still publish
 * SCREEN_AUDIO via the worklet fallback, escaping the gate.
 *
 * hasChannelPermission short-circuits to true on non-private channels, so the
 * denial scenarios make the channel private and grant the user an explicit
 * permission set that omits SHARE_SCREEN (mirrors voice-permissions.test.ts).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { ChannelPermission, StreamKind } from '@sharkord/shared';
import { initTest } from '../../__tests__/helpers';
import { VoiceRuntime } from '../../runtimes/voice';

const VOICE_CHANNEL_ID = 2;

const DENIED_SRTP = { cryptoSuite: 'AES_CM_128_HMAC_SHA1_80', keyBase64: 'client-key' } as const;

const ensureVoiceRuntime = async (): Promise<VoiceRuntime> => {
	const existing = VoiceRuntime.findById(VOICE_CHANNEL_ID);

	if (existing) {
		return existing;
	}

	const runtime = new VoiceRuntime(VOICE_CHANNEL_ID);
	await runtime.init();

	return runtime;
};

afterEach(async () => {
	const runtime = VoiceRuntime.findById(VOICE_CHANNEL_ID);

	if (!runtime) {
		return;
	}

	[...runtime.getState().users].forEach((user) => {
		runtime.removeUser(user.userId);
	});

	await runtime.destroy();
});

describe('app-audio ingest authorization', () => {
	const setupDeniedUser = async () => {
		const runtime = await ensureVoiceRuntime();
		const { caller: ownerCaller } = await initTest(1);
		const { caller: userCaller } = await initTest(2);

		await ownerCaller.channels.updatePermissions({
			channelId: VOICE_CHANNEL_ID,
			userId: 2,
			permissions: [ChannelPermission.VIEW_CHANNEL, ChannelPermission.JOIN, ChannelPermission.SPEAK],
		});

		await ownerCaller.channels.update({
			channelId: VOICE_CHANNEL_ID,
			private: true,
		});

		await userCaller.voice.join({
			channelId: VOICE_CHANNEL_ID,
			state: { micMuted: false, soundMuted: false },
		});

		return { runtime, userCaller };
	};

	test('createAppAudioIngest rejects with FORBIDDEN and creates no ingest when SHARE_SCREEN is missing', async () => {
		const { runtime, userCaller } = await setupDeniedUser();

		await expect(userCaller.voice.createAppAudioIngest()).rejects.toThrow('Insufficient channel permissions');

		expect(runtime.getAppAudioIngest(2)).toBeUndefined();
	});

	test('produceAppAudio rejects with FORBIDDEN when SHARE_SCREEN is missing', async () => {
		const { userCaller } = await setupDeniedUser();

		await expect(
			userCaller.voice.produceAppAudio({
				transportId: 'does-not-matter',
				srtpParameters: DENIED_SRTP,
			}),
		).rejects.toThrow('Insufficient channel permissions');
	});

	test('legacy produce rejects a SCREEN_AUDIO produce when SHARE_SCREEN is missing', async () => {
		const { userCaller } = await setupDeniedUser();

		await expect(
			userCaller.voice.produce({
				transportId: 'does-not-matter',
				kind: StreamKind.SCREEN_AUDIO,
				// rtpParameters is validated only as a plain object at the edge; the
				// permission check rejects before mediasoup ever sees it.
				rtpParameters: {} as never,
			}),
		).rejects.toThrow('Insufficient channel permissions');
	});

	test('createAppAudioIngest succeeds for a user with SHARE_SCREEN', async () => {
		const runtime = await ensureVoiceRuntime();
		const { caller: ownerCaller } = await initTest(1);

		await ownerCaller.voice.join({
			channelId: VOICE_CHANNEL_ID,
			state: { micMuted: false, soundMuted: false },
		});

		const ingest = await ownerCaller.voice.createAppAudioIngest();

		expect(typeof ingest.id).toBe('string');
		expect(typeof ingest.port).toBe('number');
		expect(typeof ingest.ssrc).toBe('number');
		expect(ingest.srtpParameters.keyBase64.length).toBeGreaterThan(0);
		expect(ingest.rtpParameters.codecs?.[0]?.payloadType).toBe(100);
		expect(ingest.rtpParameters.encodings?.[0]?.ssrc).toBe(ingest.ssrc);

		expect(runtime.getAppAudioIngest(1)).toBeDefined();
	});
});
