/** Exercises production native startup through the share-audio owner.
 * recover-transport-session.test.ts independently exercises the real session machine.
 * Desktop capture/RTP and server ingest dependencies here are controlled mocks.
 */
import { describe, expect, it, mock } from 'bun:test';
import { ScreenAudioMode } from '@/runtime/types';
import { deferred, flush, makeFixture, makeSession, makeStream, makeTrack, status } from './share-audio-test-harness';

const startNative = (fixture: ReturnType<typeof makeFixture>, sourceId = 'source') =>
	fixture.controller.start({
		displayStream: makeStream([]),
		desktopBridge: fixture.bridge,
		captureInput: { sourceId },
		audioMode: ScreenAudioMode.APP,
	});

describe('native share audio production startup', () => {
	it('commits native publication and closes the exact producer on stop', async () => {
		const f = makeFixture();
		expect(await startNative(f)).toBe('published');
		expect(f.deps.createPipeline).not.toHaveBeenCalled();
		await f.controller.stop();
		expect(f.deps.closeProducer).toHaveBeenCalledWith('native-1');
		expect(f.bridge.stopAppAudioCapture).toHaveBeenCalledWith('session-1');
		f.cleanup();
	});
	for (const boundary of ['capture', 'ingest', 'rtp', 'produce'] as const) {
		for (const action of ['stop', 'supersede', 'cleanup'] as const) {
			it(`${action} while native ${boundary} is deferred abandons only the old attempt`, async () => {
				const f = makeFixture();
				const gate = deferred();
				const entered = deferred();
				const hold = async () => {
					entered.resolve();
					await gate.promise;
				};
				if (boundary === 'capture')
					f.bridge.startAppAudioCapture = mock(async () => {
						await hold();
						return makeSession('old-session');
					});
				if (boundary === 'ingest') {
					const original = f.deps.createIngest;
					f.deps.createIngest = async () => {
						const result = await original();
						await hold();
						return result;
					};
				}
				if (boundary === 'rtp')
					f.bridge.startAppAudioRtp = mock(async () => {
						await hold();
						return { srtpKeyBase64: 'key' };
					});
				if (boundary === 'produce')
					f.deps.produceNative = mock(async () => {
						await hold();
						return { producerId: 'old-native' };
					});
				const first = startNative(f);
				await entered.promise;
				if (action === 'stop') await f.controller.stop();
				if (action === 'cleanup') f.cleanup();
				if (action === 'supersede') {
					f.bridge.startAppAudioCapture = mock(async () => makeSession('new-session'));
					f.deps.createIngest = mock(async () => ({
						id: 'new-ingest',
						ip: '127.0.0.1',
						port: 10000,
						ssrc: 1,
						rtpParameters: { codecs: [] },
						srtpParameters: { cryptoSuite: 'AES_CM_128_HMAC_SHA1_80' as const, keyBase64: 'key' },
					}));
					f.bridge.startAppAudioRtp = mock(async () => ({ srtpKeyBase64: 'key' }));
					f.deps.produceNative = mock(async () => ({ producerId: 'new-native' }));
					expect(await startNative(f, 'new-source')).toBe('published');
				}
				gate.resolve();
				expect(await first).toBe('abandoned');
				expect(f.deps.createPipeline).not.toHaveBeenCalled();
				if (action === 'supersede') {
					expect(f.stopRtp).not.toHaveBeenCalled();
					expect(f.bridge.stopAppAudioCapture).not.toHaveBeenCalledWith('new-session');
					expect(f.deps.abortIngest).not.toHaveBeenCalledWith('new-ingest');
					await f.controller.stop();
					expect(f.deps.closeProducer).toHaveBeenCalledWith('new-native');
				}
				f.cleanup();
			});
		}
	}
	for (const code of ['FORBIDDEN', 'UNAUTHORIZED']) {
		for (const boundary of ['ingest', 'produce'] as const) {
			it(`${code} at ${boundary} rejects without worklet or display fallback`, async () => {
				const f = makeFixture();
				const error = { data: { code } };
				if (boundary === 'ingest')
					f.deps.createIngest = mock(async () => {
						throw error;
					});
				else
					f.deps.produceNative = mock(async () => {
						throw error;
					});
				const audio = makeTrack();
				const video = makeTrack('video');
				await expect(
					f.controller.start({
						displayStream: makeStream([audio.track, video.track]),
						desktopBridge: f.bridge,
						captureInput: { sourceId: 'source' },
						audioMode: ScreenAudioMode.SYSTEM,
					}),
				).rejects.toEqual(error);
				expect(f.deps.createPipeline).not.toHaveBeenCalled();
				expect(f.produce).not.toHaveBeenCalled();
				expect(audio.stop).toHaveBeenCalled();
				expect(video.stop).not.toHaveBeenCalled();
				expect(f.bridge.stopAppAudioCapture).toHaveBeenCalledWith('session-1');
				f.cleanup();
			});
		}
	}
	it('no first native media tears down ingest before publishing the worklet', async () => {
		const f = makeFixture();
		f.deps.produceNative = mock(async () => ({ fallback: true as const }));
		expect(await startNative(f)).toBe('published');
		expect(f.deps.abortIngest).toHaveBeenCalledWith('ingest-1');
		expect(f.bridge.stopAppAudioRtp).toHaveBeenCalled();
		expect(f.bridge.startAppAudioCapture).toHaveBeenLastCalledWith({ sourceId: 'source' });
		expect(f.getStream()).toBe(f.pipelines[0]?.stream);
		f.cleanup();
		await f.controller.awaitTeardown();
	});
	it('ignores an old native status callback after a replacement session commits', async () => {
		const f = makeFixture();
		await startNative(f);
		const oldStatus = f.statuses[0];
		await f.controller.stop();
		await startNative(f, 'replacement');
		oldStatus?.(status('session-1'));
		await flush();
		expect(f.deps.warning).not.toHaveBeenCalled();
		expect(f.bridge.stopAppAudioCapture).not.toHaveBeenCalledWith('session-2');
		f.cleanup();
		await f.controller.awaitTeardown();
	});
});
