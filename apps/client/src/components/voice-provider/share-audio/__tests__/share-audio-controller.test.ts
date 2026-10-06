import { describe, expect, it, mock } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import type { AppData, Transport } from 'mediasoup-client/types';
import { ScreenAudioMode } from '@/runtime/types';
import { getScreenShareAudioOpusConfig } from '../../audio-producer-config';
import { mountShareAudioController } from '../share-audio-controller';
import {
	deferred,
	flush,
	frame,
	makeFixture,
	makePipeline,
	makeProducer,
	makeSession,
	makeStream,
	makeTrack,
	status,
} from './share-audio-test-harness';

const startWorklet = (
	f: ReturnType<typeof makeFixture>,
	displayStream = makeStream([]),
	audioMode: ScreenAudioMode.APP | ScreenAudioMode.SYSTEM = ScreenAudioMode.APP,
) => f.controller.start({ displayStream, desktopBridge: f.bridge, captureInput: { sourceId: 'source' }, audioMode });
const transport = (produce: () => Promise<ReturnType<typeof makeProducer>['producer']>) =>
	({ closed: false, produce }) as unknown as Transport<AppData>;

describe('share audio browser publication', () => {
	it('publishes the existing Opus config and stops only audio in a mixed display stream', async () => {
		const f = makeFixture();
		const audio = makeTrack();
		const video = makeTrack('video');
		expect(await f.controller.start({ displayStream: makeStream([video.track, audio.track]) })).toBe('published');
		expect(f.produce).toHaveBeenCalledWith({
			track: audio.track,
			stopTracks: false,
			...getScreenShareAudioOpusConfig(),
			appData: { kind: StreamKind.SCREEN_AUDIO },
		});
		await f.controller.stop();
		expect(audio.stop).toHaveBeenCalled();
		expect(video.stop).not.toHaveBeenCalled();
		expect(f.producers[0]?.close).toHaveBeenCalled();
		expect(f.getStream()).toBeUndefined();
		f.cleanup();
	});
	it('cleans acquired display audio when video publication fails before audio startup', async () => {
		const f = makeFixture();
		const audio = makeTrack();
		const video = makeTrack('video');
		f.controller.adoptDisplayAudio(makeStream([audio.track, video.track]));
		await f.controller.stop();
		expect(audio.stop).toHaveBeenCalled();
		expect(video.stop).not.toHaveBeenCalled();
		expect(f.produce).not.toHaveBeenCalled();
		f.cleanup();
	});

	it('republishes surviving capture and ignores the old ended callback even with the same stream', async () => {
		const f = makeFixture();
		const audio = makeTrack();
		await f.controller.start({ displayStream: makeStream([audio.track]) });
		const oldEnded = audio.track.onended;
		const stream = f.getStream();
		f.controller.detachProducer();
		f.replaceTransport();
		let commandCurrent = true;
		await f.controller.republish(() => commandCurrent);
		commandCurrent = false;
		expect(audio.stop).not.toHaveBeenCalled();
		oldEnded?.call(audio.track, new Event('ended'));
		expect(f.producers[1]?.close).not.toHaveBeenCalled();
		expect(f.getStream()).toBe(stream);
		audio.track.onended?.call(audio.track, new Event('ended'));
		expect(f.producers[1]?.close).toHaveBeenCalled();
		expect(f.getStream()).toBeUndefined();
		f.cleanup();
	});
	for (const action of ['stop', 'supersede', 'cleanup', 'transport'] as const) {
		it(`${action} during deferred browser publication cannot commit an old producer`, async () => {
			const f = makeFixture();
			const gate = deferred<ReturnType<typeof makeProducer>['producer']>();
			const entered = deferred();
			const old = makeProducer('old');
			const audio = makeTrack();
			const oldTransport = transport(async () => {
				entered.resolve();
				return gate.promise;
			});
			f.deps.getProducerTransport = () => oldTransport;
			const first = f.controller.start({ displayStream: makeStream([audio.track]) });
			await entered.promise;
			if (action === 'stop') await f.controller.stop();
			if (action === 'cleanup') f.cleanup();
			if (action === 'supersede' || action === 'transport') {
				const nextTransport = transport(f.produce);
				f.deps.getProducerTransport = () => nextTransport;
				if (action === 'supersede') await f.controller.start({ displayStream: makeStream([makeTrack().track]) });
			}
			gate.resolve(old.producer);
			if (action === 'transport') await expect(first).rejects.toThrow('superseded');
			else expect(await first).toBe('abandoned');
			expect(old.close).toHaveBeenCalled();
			if (action === 'supersede') expect(f.producers[0]?.close).not.toHaveBeenCalled();
			f.cleanup();
			await f.controller.awaitTeardown();
		});
	}
	it('failed republish retains live audio for a later transport attempt', async () => {
		const f = makeFixture();
		const audio = makeTrack();
		await f.controller.start({ displayStream: makeStream([audio.track]) });
		f.controller.detachProducer();
		f.deps.getProducerTransport = () => undefined;
		await expect(f.controller.republish()).rejects.toThrow('superseded');
		expect(audio.stop).not.toHaveBeenCalled();
		expect(f.getStream()?.getAudioTracks()).toEqual([audio.track]);
		f.cleanup();
		await f.controller.awaitTeardown();
	});
	it('stop reads the newly published stream before a React snapshot could update', async () => {
		const f = makeFixture();
		const audio = makeTrack();
		await f.controller.start({ displayStream: makeStream([audio.track]) });
		const stopping = f.controller.stop();
		expect(audio.track.readyState).toBe('ended');
		expect(f.getStream()).toBeUndefined();
		await stopping;
		f.cleanup();
	});
});

describe('share audio worklet ownership', () => {
	for (const boundary of ['capture', 'pipeline', 'publication', 'capabilities'] as const) {
		for (const action of ['stop', 'supersede', 'cleanup'] as const) {
			it(`${action} during deferred worklet ${boundary} cannot publish or destroy a successor`, async () => {
				const f = makeFixture();
				f.setNativeEnabled(false);
				const gate = deferred();
				const entered = deferred();
				const pipeline = makePipeline('old-session');
				const old = makeProducer('old');
				const hold = async () => {
					entered.resolve();
					await gate.promise;
				};
				if (boundary === 'capture')
					f.bridge.startAppAudioCapture = mock(async () => {
						await hold();
						return makeSession('old-session');
					});
				if (boundary === 'pipeline')
					f.deps.createPipeline = mock(async () => {
						await hold();
						return pipeline;
					});
				if (boundary === 'publication') {
					const held = transport(async () => {
						await hold();
						return old.producer;
					});
					f.deps.getProducerTransport = () => held;
				}
				if (boundary === 'capabilities') {
					f.deps.createPipeline = mock(async () => {
						throw new Error('worklet failed');
					});
					f.bridge.getCapabilities = mock(async () => {
						await hold();
						throw new Error('unavailable');
					});
				}
				const first = startWorklet(f);
				await entered.promise;
				if (action === 'stop') await f.controller.stop();
				if (action === 'cleanup') f.cleanup();
				let replacement: MediaStream | undefined;
				if (action === 'supersede') {
					f.bridge.startAppAudioCapture = mock(async () => makeSession('new-session'));
					f.deps.createPipeline = mock(async () => makePipeline('new-session'));
					const next = transport(f.produce);
					f.deps.getProducerTransport = () => next;
					expect(await startWorklet(f)).toBe('published');
					replacement = f.getStream();
				}
				gate.resolve();
				expect(await first).toBe('abandoned');
				if (action === 'supersede') {
					expect(f.getStream()).toBe(replacement);
					expect(replacement?.getAudioTracks()[0]?.readyState).toBe('live');
					expect(f.bridge.stopAppAudioCapture).not.toHaveBeenCalledWith('new-session');
				}
				if (boundary === 'pipeline') expect(pipeline.destroy).toHaveBeenCalled();
				if (boundary === 'publication') expect(old.close).toHaveBeenCalled();
				f.cleanup();
				await f.controller.awaitTeardown();
			});
		}
	}
	for (const liveFallback of [true, false]) {
		it(`worklet failure ${liveFallback ? 'publishes live system loopback' : 'continues without audio when loopback ended'}`, async () => {
			const f = makeFixture();
			f.setNativeEnabled(false);
			const audio = makeTrack();
			const video = makeTrack('video');
			f.deps.createPipeline = mock(async () => {
				throw new Error('worklet unavailable');
			});
			if (!liveFallback) audio.stop();
			expect(await startWorklet(f, makeStream([audio.track, video.track]), ScreenAudioMode.SYSTEM)).toBe(
				liveFallback ? 'published' : 'none',
			);
			if (liveFallback) {
				expect(f.getStream()?.getAudioTracks()).toEqual([audio.track]);
				expect(audio.track.readyState).toBe('live');
			} else {
				expect(f.getStream()).toBeUndefined();
				expect(f.produce).not.toHaveBeenCalled();
			}
			expect(video.stop).not.toHaveBeenCalled();
			f.cleanup();
			await f.controller.awaitTeardown();
		});
	}
	it('per-app failure drops display audio rather than publishing system fallback', async () => {
		const f = makeFixture();
		f.setNativeEnabled(false);
		const audio = makeTrack();
		f.deps.createPipeline = mock(async () => {
			throw new Error('worklet unavailable');
		});
		expect(await startWorklet(f, makeStream([audio.track]))).toBe('none');
		expect(audio.stop).toHaveBeenCalled();
		expect(f.produce).not.toHaveBeenCalled();
		f.cleanup();
	});
	it('no first worklet frame expires audio while video remains owned separately', async () => {
		const f = makeFixture();
		f.setNativeEnabled(false);
		await startWorklet(f);
		for (const handler of [...f.timers.values()]) handler();
		await f.controller.awaitTeardown();
		expect(f.pipelines[0]?.destroy).toHaveBeenCalled();
		expect(f.getStream()).toBeUndefined();
		expect(f.deps.warning).toHaveBeenCalled();
		f.cleanup();
	});
	it('first matching frame cancels expiry; old frame/status callbacks cannot touch replacement', async () => {
		const f = makeFixture();
		f.setNativeEnabled(false);
		await startWorklet(f);
		const oldFrame = f.frames[0];
		const oldStatus = f.statuses[0];
		oldFrame?.(frame('wrong'));
		expect(f.pipelines[0]?.pushFrame).not.toHaveBeenCalled();
		oldFrame?.(frame('session-1'));
		expect(f.pipelines[0]?.pushFrame).toHaveBeenCalledTimes(1);
		expect(f.timers.size).toBe(0);
		await f.controller.stop();
		await startWorklet(f);
		oldFrame?.(frame('session-1'));
		oldStatus?.(status('session-1'));
		await flush();
		expect(f.pipelines[0]?.pushFrame).toHaveBeenCalledTimes(1);
		expect(f.pipelines[1]?.pushFrame).not.toHaveBeenCalled();
		expect(f.pipelines[1]?.destroy).not.toHaveBeenCalled();
		expect(f.deps.warning).not.toHaveBeenCalled();
		expect(f.unsubscribeFrames).toHaveBeenCalled();
		expect(f.unsubscribeStatus).toHaveBeenCalled();
		f.cleanup();
		await f.controller.awaitTeardown();
	});
	it('pending teardown finishes before a new capture starts and cannot clear its stream', async () => {
		const f = makeFixture();
		f.setNativeEnabled(false);
		await startWorklet(f);
		const gate = deferred();
		const pipeline = f.pipelines[0];
		if (!pipeline) throw new Error('missing pipeline');
		pipeline.destroy = mock(async () => {
			await gate.promise;
			pipeline.track.stop();
		});
		const stopping = f.controller.stop();
		const replacement = startWorklet(f);
		await flush();
		expect(f.bridge.startAppAudioCapture).toHaveBeenCalledTimes(1);
		gate.resolve();
		await stopping;
		expect(await replacement).toBe('published');
		expect(f.getStream()?.getAudioTracks()[0]?.readyState).toBe('live');
		f.cleanup();
		await f.controller.awaitTeardown();
	});
	for (const action of ['stop', 'supersede', 'cleanup'] as const) {
		it(`${action} while startup waits for pending teardown never acquires abandoned capture`, async () => {
			const f = makeFixture();
			f.setNativeEnabled(false);
			await startWorklet(f);
			const gate = deferred();
			const pipeline = f.pipelines[0];
			if (!pipeline) throw new Error('missing pipeline');
			pipeline.destroy = mock(async () => {
				await gate.promise;
				pipeline.track.stop();
			});
			const stopping = f.controller.stop();
			const audio = makeTrack();
			const video = makeTrack('video');
			const waiting = startWorklet(f, makeStream([audio.track, video.track]));
			let successor: Promise<'published' | 'abandoned' | 'none'> | undefined;
			let laterStop: Promise<void> | undefined;
			if (action === 'stop') laterStop = f.controller.stop();
			if (action === 'supersede') successor = startWorklet(f);
			if (action === 'cleanup') f.cleanup();
			await flush();
			expect(f.bridge.startAppAudioCapture).toHaveBeenCalledTimes(1);
			gate.resolve();
			await stopping;
			await laterStop;
			expect(await waiting).toBe('abandoned');
			expect(audio.track.readyState).toBe('ended');
			expect(video.track.readyState).toBe('live');
			if (successor) {
				expect(await successor).toBe('published');
				expect(f.bridge.startAppAudioCapture).toHaveBeenCalledTimes(2);
			} else expect(f.bridge.startAppAudioCapture).toHaveBeenCalledTimes(1);
			f.cleanup();
			await f.controller.awaitTeardown();
		});
	}
	it('older desktop bridges publish through the worklet without native RTP methods', async () => {
		const f = makeFixture();
		f.bridge.startAppAudioRtp = undefined;
		f.bridge.stopAppAudioRtp = undefined;
		expect(await startWorklet(f)).toBe('published');
		expect(f.deps.createIngest).not.toHaveBeenCalled();
		expect(f.deps.createPipeline).toHaveBeenCalledTimes(1);
		f.cleanup();
		await f.controller.awaitTeardown();
	});

	it('old native teardown finishing after replacement cannot reset replacement active state', async () => {
		const f = makeFixture();
		const gate = deferred();
		const entered = deferred();
		f.deps.produceNative = mock(async () => ({ fallback: true as const }));
		f.bridge.stopAppAudioRtp = mock(async () => {
			entered.resolve();
			await gate.promise;
		});
		const old = startWorklet(f);
		await entered.promise;
		f.deps.produceNative = mock(async () => ({ producerId: 'new-native' }));
		expect(await startWorklet(f)).toBe('published');
		gate.resolve();
		expect(await old).toBe('abandoned');
		await f.controller.stop();
		expect(f.deps.closeProducer).toHaveBeenCalledWith('new-native');
		expect(f.bridge.stopAppAudioCapture).toHaveBeenCalledWith('session-2');
		f.cleanup();
	});
	it('old pipeline destruction finishing after replacement cannot clear its stream', async () => {
		const f = makeFixture();
		f.setNativeEnabled(false);
		const pipelineGate = deferred<ReturnType<typeof makePipeline>>();
		const entered = deferred();
		const destroyGate = deferred();
		f.deps.createPipeline = mock(async () => {
			entered.resolve();
			return pipelineGate.promise;
		});
		const old = startWorklet(f);
		await entered.promise;
		f.deps.createPipeline = mock(async () => makePipeline('new-session'));
		await startWorklet(f);
		const stream = f.getStream();
		const oldPipeline = makePipeline('session-1');
		oldPipeline.destroy = mock(async () => {
			await destroyGate.promise;
			oldPipeline.track.stop();
		});
		pipelineGate.resolve(oldPipeline);
		await flush();
		expect(f.getStream()).toBe(stream);
		destroyGate.resolve();
		expect(await old).toBe('abandoned');
		expect(f.getStream()).toBe(stream);
		expect(stream?.getAudioTracks()[0]?.readyState).toBe('live');
		f.cleanup();
		await f.controller.awaitTeardown();
	});
});

describe('share audio recovery integration', () => {
	for (const failure of ['native authorization', 'fallback republication'] as const) {
		it(`releases unpublished display fallback after failed ${failure} recovery`, async () => {
			const f = makeFixture();
			const audio = makeTrack();
			const video = makeTrack('video');
			f.setNativeEnabled(false);
			f.deps.createPipeline = mock(async () => {
				throw new Error('worklet unavailable');
			});
			await startWorklet(f, makeStream([audio.track, video.track]), ScreenAudioMode.SYSTEM);
			if (failure === 'native authorization') {
				f.setNativeEnabled(true);
				f.deps.produceNative = mock(async () => {
					throw Object.assign(new Error('denied'), { data: { code: 'FORBIDDEN' } });
				});
			} else {
				f.produce.mockImplementation(async () => {
					throw new Error('fallback publication failed');
				});
			}
			await expect(f.controller.recover()).rejects.toThrow();
			expect(f.getStream()).toBeUndefined();
			expect(audio.track.readyState).toBe('ended');
			expect(video.track.readyState).toBe('live');
			await f.controller.stop();
			f.cleanup();
			await f.controller.awaitTeardown();
		});
	}
	it('transfers display fallback ownership to successful recovery publication', async () => {
		const f = makeFixture();
		const audio = makeTrack();
		f.setNativeEnabled(false);
		f.deps.createPipeline = mock(async () => {
			throw new Error('worklet unavailable');
		});
		await startWorklet(f, makeStream([audio.track]), ScreenAudioMode.SYSTEM);
		const previous = f.getStream();
		await f.controller.recover();
		expect(f.getStream()).not.toBe(previous);
		expect(f.getStream()?.getAudioTracks()[0]).toBe(audio.track);
		expect(audio.track.readyState).toBe('live');
		await f.controller.stop();
		expect(audio.track.readyState).toBe('ended');
		f.cleanup();
	});
	it('does not release replacement audio when old fallback recovery rejects late', async () => {
		const f = makeFixture();
		const old = makeTrack();
		f.setNativeEnabled(false);
		f.deps.createPipeline = mock(async () => {
			throw new Error('worklet unavailable');
		});
		await startWorklet(f, makeStream([old.track]), ScreenAudioMode.SYSTEM);
		const pending = deferred<ReturnType<typeof makeProducer>['producer']>();
		const entered = deferred();
		f.produce.mockImplementationOnce(() => {
			entered.resolve();
			return pending.promise;
		});
		const recovery = f.controller.recover().catch(() => {});
		await entered.promise;
		await f.controller.stop();
		const replacement = makeTrack();
		await f.controller.start({ displayStream: makeStream([replacement.track]) });
		const stream = f.getStream();
		pending.reject(new Error('old fallback failed'));
		await recovery;
		expect(f.getStream()).toBe(stream);
		expect(replacement.track.readyState).toBe('live');
		expect(old.track.readyState).toBe('ended');
		f.cleanup();
		await f.controller.awaitTeardown();
	});
	it('cancels queued recovery across lifecycle cleanup and remount before acquiring media', async () => {
		const f = makeFixture();
		f.setNativeEnabled(false);
		await startWorklet(f);
		const gate = deferred();
		const entered = deferred();
		f.bridge.startAppAudioCapture = mock(async () => {
			entered.resolve();
			await gate.promise;
			return makeSession('old-recovery');
		});
		const first = f.controller.recover();
		await entered.promise;
		const queued = f.controller.recover();
		f.cleanup();
		const cleanup = mountShareAudioController(f.controller);
		f.bridge.startAppAudioCapture = mock(async () => makeSession('fresh-session'));
		await startWorklet(f);
		const stream = f.getStream();
		gate.resolve();
		await Promise.all([first, queued]);
		expect(f.bridge.startAppAudioCapture).toHaveBeenCalledTimes(1);
		expect(f.getStream()).toBe(stream);
		expect(stream?.getAudioTracks()[0]?.readyState).toBe('live');
		cleanup();
		await f.controller.awaitTeardown();
	});
	it('stop reaches live display fallback while recovery has temporarily unpublished it', async () => {
		const f = makeFixture();
		f.setNativeEnabled(false);
		const audio = makeTrack();
		const video = makeTrack('video');
		f.deps.createPipeline = mock(async () => {
			throw new Error('worklet unavailable');
		});
		await startWorklet(f, makeStream([audio.track, video.track]), ScreenAudioMode.SYSTEM);
		f.setNativeEnabled(true);
		const gate = deferred();
		const entered = deferred();
		f.bridge.startAppAudioCapture = mock(async () => {
			entered.resolve();
			await gate.promise;
			return makeSession('recovering');
		});
		const recovery = f.controller.recover();
		await entered.promise;
		expect(f.getStream()).toBeUndefined();
		expect(audio.track.readyState).toBe('live');
		await f.controller.stop();
		expect(audio.track.readyState).toBe('ended');
		expect(video.track.readyState).toBe('live');
		gate.resolve();
		await recovery;
		expect(f.produce).toHaveBeenCalledTimes(1);
		f.cleanup();
	});
	it('native recovery releases the live display fallback after taking over publication', async () => {
		const f = makeFixture();
		f.setNativeEnabled(false);
		const audio = makeTrack();
		const video = makeTrack('video');
		f.deps.createPipeline = mock(async () => {
			throw new Error('worklet unavailable');
		});
		await startWorklet(f, makeStream([audio.track, video.track]), ScreenAudioMode.SYSTEM);
		f.setNativeEnabled(true);
		await f.controller.recover();
		expect(audio.track.readyState).toBe('ended');
		expect(video.track.readyState).toBe('live');
		expect(f.getStream()).toBeUndefined();
		f.cleanup();
		await f.controller.awaitTeardown();
	});

	it('consults current screen video liveness before recovery', async () => {
		const f = makeFixture();
		await startWorklet(f);
		f.setVideoLive(false);
		await f.controller.recover();
		expect(f.bridge.startAppAudioCapture).toHaveBeenCalledTimes(1);
		expect(f.controller.hasDesktopIntent()).toBe(false);
		f.cleanup();
		await f.controller.awaitTeardown();
	});
	it('reads current native setting after pending teardown rather than freezing it at start', async () => {
		const f = makeFixture();
		await startWorklet(f);
		const gate = deferred();
		f.bridge.stopAppAudioRtp = mock(async () => {
			await gate.promise;
		});
		const stop = f.controller.stop();
		const replacement = startWorklet(f);
		f.setNativeEnabled(false);
		gate.resolve();
		await stop;
		expect(await replacement).toBe('published');
		expect(f.deps.createPipeline).toHaveBeenCalledTimes(1);
		expect(f.deps.createIngest).toHaveBeenCalledTimes(1);
		f.cleanup();
		await f.controller.awaitTeardown();
	});
});
