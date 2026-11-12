import { describe, expect, it } from 'bun:test';
import type { AppData, Producer } from 'mediasoup-client/types';
import { createOwnMicControls } from '../../own-mic-controls';
import { recoverTransportMicrophone } from '../../session/transport-recovery-microphone';
import { resolveCaptureAction } from '../microphone-integration';
import { MicPipelineSupersededError } from '../microphone-pipeline-controller';

import {
	createHarness,
	createProducer,
	createStream,
	defaultInput,
	deferred,
	flush,
} from './microphone-integration-fixture';

describe('microphone integration', () => {
	it('acquires no environment resources during construction and rejects work before mounting', async () => {
		const h = createHarness();
		expect(h.state.environmentReads).toBe(0);
		expect(await h.integration.start()).toEqual({ status: 'superseded' });
		await expect(h.integration.prepare()).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(h.captures).toHaveLength(0);
		expect(h.scheduler.pending()).toBe(0);
	});
	it('restarts across the neutral gain threshold and updates an existing gain graph in place', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		expect(await h.integration.start()).toEqual({ status: 'started' });
		h.volumeChange(70);
		await flush();
		expect(h.captures).toHaveLength(2);
		expect(h.gains.map((gain) => gain.volume)).toEqual([70]);
		expect(h.streams[0]?.track.readyState).toBe('ended');
		h.volumeChange(45);
		expect(h.captures).toHaveLength(2);
		expect(h.gains[0]?.updates).toEqual([0.45]);
		h.volumeChange(150);
		await flush();
		expect(h.captures).toHaveLength(3);
		expect(h.gains[0]?.destroyed).toBe(true);
		expect(h.inputs.localAudioStream).toBe(h.streams[2]);
		cleanup();
		expect(h.scheduler.pending()).toBe(0);
	});
	it('ignores unrelated volume events and avoids starting without channel or publication', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		h.volumeChange(50);
		await flush();
		expect(h.captures).toHaveLength(0);
		h.state.volume = 100;
		await h.integration.start();
		h.volumeChange(50, 'remote-user');
		h.inputs.currentVoiceChannelId = undefined;
		h.volumeChange(50);
		await flush();
		expect(h.captures).toHaveLength(1);
		cleanup();
	});
	it('coalesces threshold restarts and reports failure without blocking later work', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		const capture = deferred<MediaStream>();
		h.captureResults.push(capture.promise);
		h.volumeChange(70);
		h.volumeChange(50);
		await flush();
		expect(h.captures).toHaveLength(2);
		capture.reject(new Error('capture unavailable'));
		await flush();
		expect(h.errors).toEqual(['capture unavailable']);
		h.state.micMuted = false;
		expect(await h.integration.start()).toEqual({ status: 'started' });
		h.volumeChange(100);
		await flush();
		expect(h.captures).toHaveLength(4);
		cleanup();
	});
	it('supersedes a queued volume restart across lifecycle cleanup and replay', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		const publication = deferred<Producer<AppData>>();
		h.publicationResults.push(publication.promise);
		const start = h.integration.start();
		await flush();
		h.volumeChange(50);
		cleanup();
		expect(h.inputs.localAudioStream).toBeUndefined();
		const replayCleanup = h.mount();
		const preparing = h.integration.prepare();
		const oldProducer = createProducer('old-producer');
		publication.resolve(oldProducer);
		const prepared = await preparing;
		await h.integration.publish(prepared);
		expect(await start).toEqual({ status: 'superseded' });
		await flush();
		expect(oldProducer.closed).toBe(true);
		expect(h.captures).toHaveLength(2);
		expect(h.inputs.localAudioStream).toBe(prepared.outboundStream);
		expect(h.errors).toEqual([]);
		cleanup();
		expect(h.integration.owns(prepared)).toBe(true);
		replayCleanup();
	});
	it('reads current committed settings when a queued reconciliation builds', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		h.inputs.devices = { ...h.inputs.devices, microphoneId: 'old-input' };
		const capture = deferred<MediaStream>();
		h.captureResults.push(capture.promise);
		const first = h.integration.start();
		await flush();
		const queued = h.integration.restart();
		h.inputs.devices = { ...h.inputs.devices, microphoneId: 'new-input', wasmNoiseSuppressionEnabled: true };
		h.state.volume = 40;
		capture.resolve(createStream());
		expect(await first).toEqual({ status: 'started' });
		expect(await queued).toEqual({ status: 'started' });
		expect(h.captures.map((capture) => capture.audio)).toEqual([
			{
				deviceId: { exact: 'old-input' },
				autoGainControl: true,
				echoCancellation: true,
				noiseSuppression: true,
				sampleRate: 48000,
			},
			{
				deviceId: { exact: 'new-input' },
				autoGainControl: true,
				echoCancellation: true,
				noiseSuppression: false,
				sampleRate: 48000,
			},
		]);
		expect(h.processingInputs.map((input) => input.wasmNoiseSuppressionEnabled)).toEqual([true]);
		expect(h.gains.map((gain) => gain.volume)).toEqual([40]);
		cleanup();
	});
	it('prepares without transport and reads publication-time channel settings and mute intent', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		h.state.transport = undefined;
		const prepared = await h.integration.prepare();
		expect(h.publications).toHaveLength(0);
		expect(h.inputs.localAudioStream).toBeUndefined();
		h.newTransport();
		h.state.channelSettings = { voiceBitrate: 48_000, voiceDtx: true };
		h.state.micMuted = true;
		await h.integration.publish(prepared);
		expect(prepared.outboundAudioTrack.readyState).toBe('live');
		expect(prepared.outboundAudioTrack.enabled).toBe(false);
		expect(h.publications).toHaveLength(1);
		expect(h.publications[0]?.options.encodings).toEqual([{ maxBitrate: 48_000 }]);
		cleanup();
	});
	for (const boundary of ['cleanup', 'replacement'] as const) {
		it(`disposes stale capture after ${boundary} without removing a successor publication`, async () => {
			const h = createHarness();
			const cleanup = h.mount();
			const capture = deferred<MediaStream>();
			h.captureResults.push(capture.promise);
			const oldResult = h.integration.prepare().catch((error: unknown) => error);
			await flush();
			if (boundary === 'cleanup') cleanup();
			const replayCleanup = boundary === 'cleanup' ? h.mount() : cleanup;
			const preparing = h.integration.prepare();
			const oldStream = createStream('old-capture');
			capture.resolve(oldStream);
			const prepared = await preparing;
			await h.integration.publish(prepared);
			expect(await oldResult).toBeInstanceOf(MicPipelineSupersededError);
			expect(oldStream.track.readyState).toBe('ended');
			expect(h.inputs.localAudioStream).toBe(prepared.outboundStream);
			expect(prepared.outboundAudioTrack.readyState).toBe('live');
			replayCleanup();
		});
	}
	it('retains lifecycle currency across replay and rejects old preparation and publication', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		const lifecycle = h.integration.createLifecycleLease();
		const prepared = await h.integration.prepare(lifecycle.isCurrent);
		const publication = deferred<Producer<AppData>>();
		h.publicationResults.push(publication.promise);
		const pending = h.integration.publish(prepared, lifecycle.isCurrent).catch((error: unknown) => error);
		cleanup();
		expect(lifecycle.isCurrent()).toBe(false);
		expect(prepared.outboundAudioTrack.readyState).toBe('ended');
		const replayCleanup = h.mount();
		const preparing = h.integration.prepare();
		const staleProducer = createProducer('stale');
		publication.resolve(staleProducer);
		const fresh = await preparing;
		await h.integration.publish(fresh);
		expect(await pending).toBeInstanceOf(MicPipelineSupersededError);
		expect(staleProducer.closed).toBe(true);
		await expect(h.integration.prepare(lifecycle.isCurrent)).rejects.toBeInstanceOf(MicPipelineSupersededError);
		await expect(h.integration.publish(prepared)).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(h.integration.owns(fresh)).toBe(true);
		expect(h.inputs.localAudioStream).toBe(fresh.outboundStream);
		replayCleanup();
	});
	it('closes a late producer from a replaced transport and preserves capture for republishing', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		const prepared = await h.integration.prepare();
		const publication = deferred<Producer<AppData>>();
		h.publicationResults.push(publication.promise);
		const pending = h.integration.publish(prepared).catch((error: unknown) => error);
		h.newTransport();
		const republishing = h.integration.publish('current');
		const staleProducer = createProducer('stale-transport');
		publication.resolve(staleProducer);
		await republishing;
		expect(await pending).toBeUndefined();
		expect(staleProducer.closed).toBe(true);
		expect(h.closedOnServer).toContain('stale-transport');
		expect(prepared.outboundAudioTrack.readyState).toBe('live');
		expect(h.captures).toHaveLength(1);
		cleanup();
	});
	it('fences activity by producer identity and orders broadcasts across replacements', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		const oldMonitor = h.monitors[0];
		if (!oldMonitor) throw new Error('Expected activity monitor');
		oldMonitor.onUpdate(false);
		oldMonitor.onUpdate(true);
		await h.integration.restart();
		expect(oldMonitor.removed).toBe(true);
		oldMonitor.onUpdate(true);
		const monitor = h.monitors[1];
		if (!monitor) throw new Error('Expected replacement monitor');
		monitor.onUpdate(false);
		h.inputs.ownUserId = 20;
		monitor.onUpdate(true);
		h.inputs.isConnected = false;
		h.integration.syncInputs();
		expect(monitor.removed).toBe(true);
		expect(h.broadcasts).toEqual([
			{ isSpeaking: true, seq: 1, producerId: 'producer-1' },
			{ isSpeaking: false, seq: 2, producerId: 'producer-1' },
			{ isSpeaking: true, seq: 3, producerId: 'producer-2' },
			{ isSpeaking: false, seq: 4, producerId: 'producer-2' },
		]);
		expect(h.localActivity.at(-1)).toEqual({ userId: 20, isSpeaking: false });
		cleanup();
	});
	for (const muted of [false, true]) {
		it(`handles default-input movement by ${muted ? 'tearing down for unmute' : 'reacquiring through recovery'}`, async () => {
			const h = createHarness();
			const cleanup = h.mount();
			await h.integration.start();
			h.state.micMuted = muted;
			h.integration.setMuted(muted);
			h.state.defaultGroupId = 'physical-b';
			h.state.captureGroupId = 'physical-b';
			h.deviceChange();
			h.deviceChange();
			h.scheduler.advance(499);
			expect(h.state.enumerationCalls).toBe(0);
			h.scheduler.advance(1);
			await flush();
			expect(h.streams[0]?.track.readyState).toBe('ended');
			expect(h.captures).toHaveLength(muted ? 1 : 2);
			expect(h.inputs.localAudioStream).toBe(muted ? undefined : h.streams[1]);
			expect(h.state.terminalMutes).toBe(0);
			cleanup();
		});
	}
	it('deduplicates a handled default-input move when capture stays on the old group', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		h.state.defaultGroupId = 'physical-b';
		h.deviceChange();
		h.scheduler.advance(500);
		await flush();
		expect(h.captures).toHaveLength(2);
		h.deviceChange();
		h.scheduler.advance(500);
		await flush();
		expect(h.captures).toHaveLength(2);
		expect(h.scheduler.pending()).toBe(1); // Only the controller's stability timer.
		cleanup();
	});
	it('waits for default-device metadata within the existing bounded polling window', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		h.enumerations.push(Promise.resolve([defaultInput('')]));
		h.deviceChange();
		h.scheduler.advance(500);
		await flush();
		expect(h.captures).toHaveLength(1);
		h.state.defaultGroupId = 'physical-b';
		h.state.captureGroupId = 'physical-b';
		h.scheduler.advance(250);
		await flush();
		expect(h.state.enumerationCalls).toBe(2);
		expect(h.captures).toHaveLength(2);
		h.deviceChange();
		h.scheduler.advance(500);
		await flush();
		for (let retry = 0; retry < 6; retry += 1) {
			h.scheduler.advance(250);
			await flush();
		}
		expect(h.state.enumerationCalls).toBe(9);
		expect(h.captures).toHaveLength(2);
		expect(h.scheduler.pending()).toBe(1);
		cleanup();
	});
	it('keeps failed default-input retries and terminal mute in the existing controller', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		h.state.defaultGroupId = 'physical-b';
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const capture = deferred<MediaStream>();
			capture.reject(new Error('capture lost'));
			h.captureResults.push(capture.promise);
		}
		h.deviceChange();
		h.scheduler.advance(500);
		await flush();
		expect(h.captures).toHaveLength(4);
		expect(h.state.terminalMutes).toBe(1);
		expect(h.inputs.localAudioStream).toBeUndefined();
		expect(h.integration.getRawTrack()).toBeUndefined();
		h.state.micMuted = false;
		h.integration.resetRawRecoveryBudget();
		h.integration.setMuted(false);
		expect(await h.integration.start()).toEqual({ status: 'started' });
		cleanup();
	});
	it('mutes its own live capture before committing terminal muted state', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		const track = h.inputs.localAudioStream?.getAudioTracks()[0];
		expect(track?.enabled).toBe(true);
		h.integration.commitTerminalMute();
		expect(h.terminalCommitTrackStates).toEqual([false]);
		expect(h.state.terminalMutes).toBe(1);
		expect(track?.readyState).toBe('live');
		cleanup();
	});
	for (const boundary of ['cleanup', 'replacement', 'selection', 'channel'] as const) {
		it(`ignores deferred device enumeration after ${boundary}`, async () => {
			const h = createHarness();
			const cleanup = h.mount();
			await h.integration.start();
			const devices = deferred<MediaDeviceInfo[]>();
			h.enumerations.push(devices.promise);
			h.deviceChange();
			h.scheduler.advance(500);
			await flush();
			expect(h.state.enumerationCalls).toBe(1);
			if (boundary === 'cleanup') cleanup();
			if (boundary === 'replacement') await h.integration.restart();
			if (boundary === 'selection') h.inputs.devices = { ...h.inputs.devices, microphoneId: 'explicit' };
			if (boundary === 'channel') h.inputs.currentVoiceChannelId = 2;
			if (boundary === 'selection' || boundary === 'channel') h.integration.syncInputs();
			h.state.micMuted = true;
			const currentStream = h.inputs.localAudioStream;
			devices.resolve([defaultInput('physical-b')]);
			await flush();
			expect(h.inputs.localAudioStream).toBe(currentStream);
			expect(h.captures).toHaveLength(boundary === 'replacement' ? 2 : 1);
			expect(h.scheduler.pending()).toBe(boundary === 'cleanup' || boundary === 'channel' ? 0 : 1);
			cleanup();
		});
	}
});

describe('capture restart policy', () => {
	for (const demand of ['unmuted', 'talk held'])
		it(`settings restart failure fails closed for ${demand}`, async () => {
			const h = createHarness();
			h.state.micMuted = demand === 'talk held';
			h.state.talkHeld = demand === 'talk held';
			const cleanup = h.mount();
			await h.integration.start();
			h.captureResults.push(Promise.reject(new Error('settings acquisition')));
			expect((await h.integration.restart()).status).toBe('failed');
			expect(h.state.terminalMutes).toBe(1);
			expect(h.errors).toEqual(['settings acquisition']);
			cleanup();
		});
	it('skips settings and volume restarts when capture is not wanted', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		h.state.micMuted = true;
		expect((await h.integration.restart()).status).toBe('superseded');
		h.volumeChange(50);
		await flush();
		expect(h.captures).toHaveLength(1);
		cleanup();
	});
	it('a settings acquisition failure cannot mute a newer operation', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		const pending = deferred<MediaStream>();
		h.captureResults.push(pending.promise);
		const old = h.integration.restart();
		await flush();
		h.state.operation += 1;
		pending.reject(new Error('old'));
		await old;
		expect(h.state.terminalMutes).toBe(0);
		expect(h.errors).toEqual([]);
		cleanup();
	});
	it('a closed transmit gate leaves wanted capture and activity inactive', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		h.state.gateOpen = false;
		await h.integration.start();
		expect(h.inputs.localAudioStream?.getAudioTracks()[0]?.enabled).toBe(false);
		expect(h.monitors).toHaveLength(0);
		cleanup();
	});
});

it('retires a pending capture restart across same-channel session cleanup and rejoin', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const pending = deferred<MediaStream>();
	h.captureResults.push(pending.promise);
	const old = h.integration.restart();
	await flush();
	await h.integration.cleanup();
	pending.reject(new Error('retired session'));
	expect((await old).status).toBe('superseded');
	expect(h.state.terminalMutes).toBe(0);
	expect(h.errors).toEqual([]);
	dispose();
});

describe('shared capture boundary', () => {
	for (const path of ['settings', 'raw loss', 'transport'] as const) {
		it(`waits for publication during ${path} despite a newer push operation`, async () => {
			const h = createHarness();
			const dispose = h.mount();
			await h.integration.start();
			const publication = deferred<Producer<AppData>>();
			h.publicationResults.push(publication.promise);
			let result: Promise<unknown> | undefined;
			if (path === 'settings') result = h.integration.restart();
			else if (path === 'transport') {
				h.newTransport();
				result = h.integration.start();
			} else {
				const track = h.integration.getRawTrack();
				track?.dispatchEvent(new Event('ended'));
				h.scheduler.advance(1000);
			}
			await flush();
			expect(h.integration.getRawTrack()?.readyState).toBe('live');
			let ensured = false;
			const controls = createOwnMicControls({
				getIntent: () => ({ micMuted: h.state.micMuted, soundMuted: false }),
				isMicWanted: () => !h.state.micMuted,
				isMicMutedWithoutTest: () => h.state.micMuted,
				setOwnVoiceIntent: () => {},
				cancelPushHold: () => {},
				getCurrentVoiceChannelId: () => h.inputs.currentVoiceChannelId,
				hasLiveMicCapture: () => h.integration.getRawTrack()?.readyState === 'live',
				startMicStream: h.integration.start,
				resetMicRecoveryBudget: h.integration.resetRawRecoveryBudget,
				beginOperation: () => ++h.state.operation,
				playSound: () => {},
			});
			h.state.operation += 1;
			const ensure = controls.ensureMicStarted().then(() => {
				ensured = true;
			});
			await flush();
			expect(ensured).toBe(false);
			publication.resolve(createProducer('replacement'));
			await result;
			await ensure;
			expect(h.integration.getRawTrack()?.readyState).toBe('live');
			expect(h.state.terminalMutes).toBe(0);
			expect(h.errors).toEqual([]);
			dispose();
		});
	}
	for (const change of ['settings', 'volume'] as const) {
		it(`discards muted ${change} capture and rebuilds with current settings`, async () => {
			const h = createHarness();
			const dispose = h.mount();
			await h.integration.start();
			const old = h.integration.getRawTrack();
			h.state.micMuted = true;
			h.inputs.devices = { ...h.inputs.devices, microphoneId: 'new-device' };
			if (change === 'settings') await h.integration.restart();
			else {
				h.volumeChange(50);
				await flush();
			}
			expect(old?.readyState).toBe('ended');
			expect(h.integration.getRawTrack()).toBeUndefined();
			expect(h.captures).toHaveLength(1);
			h.state.micMuted = false;
			await h.integration.start();
			expect(h.captures[1]?.audio).toMatchObject({ deviceId: { exact: 'new-device' } });
			if (change === 'volume') expect(h.gains.at(-1)?.volume).toBe(50);
			dispose();
		});
	}
});

for (const join of [false, true])
	it(`rebuilds raw loss during pending ${join ? 'join' : 'start'} with gain`, async () => {
		const h = createHarness();
		const dispose = h.mount();
		h.volumeChange(70);
		h.inputs.devices = { ...h.inputs.devices, wasmNoiseSuppressionEnabled: true };
		const publication = deferred<Producer<AppData>>();
		h.publicationResults.push(publication.promise);
		const result = join ? h.integration.prepare().then((p) => h.integration.publish(p)) : h.integration.start();
		await flush();
		const raw = h.integration.getRawTrack();
		raw?.stop();
		raw?.dispatchEvent(new Event('ended'));
		publication.resolve(createProducer('dead'));
		await result;
		await flush();
		expect(h.integration.getRawTrack()?.readyState).toBe('live');
		expect(h.captures).toHaveLength(2);
		expect(h.producers.at(-1)?.closed).toBe(false);
		expect(h.inputs.localAudioStream?.getAudioTracks()[0]?.readyState).toBe('live');
		expect(h.errors).toEqual([]);
		expect(h.state.terminalMutes).toBe(0);
		dispose();
	});
for (const cleanup of [false, true])
	it(`gives current owner its own capture after retirement, cleanup=${cleanup}`, async () => {
		const h = createHarness();
		const dispose = h.mount();
		const capture = deferred<MediaStream>();
		h.captureResults.push(capture.promise);
		let current = true;
		const old = h.integration.start(() => current);
		await flush();
		current = false;
		if (cleanup) await h.integration.cleanup();
		const successor = h.integration.start();
		capture.resolve(createStream());
		expect((await old).status).toBe('superseded');
		expect((await successor).status).toBe('started');
		expect(h.integration.getRawTrack()?.readyState).toBe('live');
		expect(h.captures).toHaveLength(2);
		dispose();
	});
it('failed join after direct muted teardown cannot strand an unmute', async () => {
	const h = createHarness();
	const dispose = h.mount();
	await h.integration.prepare();
	h.state.micMuted = true;
	const raw = h.integration.getRawTrack();
	raw?.stop();
	raw?.dispatchEvent(new Event('ended'));
	await flush();
	h.state.micMuted = false;
	const result = await Promise.race([
		h.integration.start(),
		new Promise<{ status: 'timeout' }>((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 100)),
	]);
	expect(result.status).toBe('started');
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});
it('ensure after pending success does not rebuild', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const capture = deferred<MediaStream>();
	h.captureResults.push(capture.promise);
	const first = h.integration.start();
	const second = h.integration.start();
	capture.resolve(createStream());
	expect((await first).status).toBe('started');
	expect((await second).status).toBe('started');
	await h.integration.start();
	expect(h.captures).toHaveLength(1);
	dispose();
});
it('exhaustively resolves desired and actual capture states', () => {
	// Bits: wanted, present, matches, publication required, published.
	const outcomes = [
		'idle',
		'idle',
		'idle',
		'idle',
		'idle',
		'idle',
		'idle',
		'idle',
		'discard',
		'discard',
		'discard',
		'discard',
		'discard',
		'discard',
		'discard',
		'discard',
		'build',
		'build',
		'build',
		'build',
		'build',
		'build',
		'build',
		'build',
		'discard',
		'discard',
		'discard',
		'discard',
		'idle',
		'idle',
		'publish',
		'idle',
	] as const;
	for (const [bits, outcome] of outcomes.entries()) {
		expect(
			resolveCaptureAction({
				wanted: Boolean(bits & 16),
				retain: Boolean(bits & 16),
				present: Boolean(bits & 8),
				matches: Boolean(bits & 4),
				publicationRequired: Boolean(bits & 2),
				published: Boolean(bits & 1),
			}),
		).toBe(outcome);
	}
});

it('bounds repeated raw losses before one recovery has settled', async () => {
	const h = createHarness();
	const dispose = h.mount();
	h.volumeChange(70);
	const deferredPublications = Array.from({ length: 5 }, () => deferred<Producer<AppData>>());
	h.publicationResults.push(...deferredPublications.map((p) => p.promise));
	const starting = h.integration.start();
	for (const [index, publication] of deferredPublications.entries()) {
		await flush();
		const raw = h.integration.getRawTrack();
		if (!raw) break;
		raw.stop();
		raw.dispatchEvent(new Event('ended'));
		publication.resolve(createProducer(`lost-${index}`));
	}
	await starting;
	await flush();
	expect(h.state.terminalMutes).toBe(1);
	expect(h.integration.getRawTrack()).toBeUndefined();
	expect(h.captures.length).toBeLessThanOrEqual(4);
	dispose();
});
it('a fresh talk demand after exhaustion gets one deliberately reset attempt', async () => {
	const h = createHarness();
	const dispose = h.mount();
	await h.integration.start();
	for (let n = 0; n < 4; n++) {
		const raw = h.integration.getRawTrack();
		raw?.stop();
		raw?.dispatchEvent(new Event('ended'));
		await flush();
	}
	expect(h.state.terminalMutes).toBe(1);
	h.state.talkHeld = true;
	h.integration.resetRawRecoveryBudget();
	const before = h.captures.length;
	expect((await h.integration.start()).status).toBe('started');
	expect(h.captures.length).toBe(before + 1);
	const raw = h.integration.getRawTrack();
	raw?.stop();
	raw?.dispatchEvent(new Event('ended'));
	await flush();
	expect(h.state.terminalMutes).toBe(1);
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});

it('transport recovery waits for its own current capture when the previous caller retired', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const capture = deferred<MediaStream>();
	h.captureResults.push(capture.promise);
	let current = true;
	const retired = h.integration.start(() => current);
	await flush();
	current = false;
	const recovery = recoverTransportMicrophone(
		{ recoveryJoined: true, micMuted: false, canSpeak: true, hasCurrentStream: false, currentTrackLive: false },
		{
			start: () => h.integration.start(() => true),
			publishCurrent: () => h.integration.publish('current'),
			discardCurrent: h.integration.cleanup,
			onStartFailed: () => {
				throw Error('unexpected failure');
			},
		},
	);
	capture.resolve(createStream());
	expect(await recovery).toBe('started');
	expect((await retired).status).toBe('superseded');
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});

it('join publication settles a replacement after raw loss between preparation and transport readiness', async () => {
	const h = createHarness();
	const dispose = h.mount();
	h.state.transport = undefined;
	h.volumeChange(70);
	const prepared = await h.integration.prepare();
	const raw = h.integration.getRawTrack();
	raw?.stop();
	raw?.dispatchEvent(new Event('ended'));
	await flush();
	h.newTransport();
	await h.integration.publish(prepared);
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	expect(h.captures).toHaveLength(2);
	expect(h.state.terminalMutes).toBe(0);
	dispose();
});
it('volume shape changes during capture invalidate the build before publication', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const capture = deferred<MediaStream>();
	h.captureResults.push(capture.promise);
	const pending = h.integration.start();
	await flush();
	h.volumeChange(70);
	capture.resolve(createStream());
	expect((await pending).status).toBe('started');
	expect(h.gains.at(-1)?.volume).toBe(70);
	expect(h.captures).toHaveLength(2);
	dispose();
});

for (const retirement of ['same-channel cleanup', 'deactivate/reactivate'] as const) {
	it(`a retired start cannot hide successor join preparation after ${retirement}`, async () => {
		const h = createHarness();
		const dispose = h.mount();
		try {
			const oldCapture = deferred<MediaStream>();
			h.captureResults.push(oldCapture.promise);
			const old = h.integration.start();
			await flush();
			if (retirement === 'same-channel cleanup') await h.integration.cleanup();
			else {
				await h.integration.deactivate();
				h.integration.activate();
			}
			h.state.transport = undefined;
			const newCapture = deferred<MediaStream>();
			h.captureResults.push(newCapture.promise);
			const joinPrepared = h.integration.prepare().then(
				(prepared) => ({ prepared }),
				(error: unknown) => ({ error }),
			);
			await flush();
			const controls = createOwnMicControls({
				getIntent: () => ({ micMuted: h.state.micMuted, soundMuted: false }),
				isMicWanted: () => !h.state.micMuted,
				isMicMutedWithoutTest: () => h.state.micMuted,
				setOwnVoiceIntent: (intent) => {
					if (intent.micMuted !== undefined) h.state.micMuted = intent.micMuted;
				},
				cancelPushHold: () => {},
				getCurrentVoiceChannelId: () => h.inputs.currentVoiceChannelId,
				hasLiveMicCapture: () => h.integration.getRawTrack()?.readyState === 'live',
				startMicStream: h.integration.start,
				resetMicRecoveryBudget: h.integration.resetRawRecoveryBudget,
				beginOperation: () => ++h.state.operation,
				playSound: () => {},
			});
			let ensured = false;
			const ensure = controls.ensureMicStarted().then(() => {
				ensured = true;
			});
			oldCapture.resolve(createStream('retired'));
			await old;
			await flush();
			await flush();
			await flush();
			const ensuredBeforeJoin = ensured;
			const capturesBeforeJoin = h.captures.length;
			h.newTransport();
			const successor = createStream('new-session');
			newCapture.resolve(successor);
			const result = await joinPrepared;
			if ('prepared' in result) await h.integration.publish(result.prepared);
			await ensure;
			expect(ensuredBeforeJoin).toBe(false);
			expect(capturesBeforeJoin).toBe(2);
			expect(h.captures).toHaveLength(2);
			expect('prepared' in result).toBe(true);
			expect(h.integration.getRawTrack()).toBe(successor.track);
			expect(successor.track.readyState).toBe('live');
			expect(h.producers.at(-1)?.closed).toBe(false);
			expect(h.state.micMuted).toBe(false);
			expect(h.state.terminalMutes).toBe(0);
			expect(h.errors).toEqual([]);
		} finally {
			dispose();
		}
	});
}

it('a stale prepare cannot retire or strand a live successor', async () => {
	const h = createHarness();
	const dispose = h.mount();
	await h.integration.start();
	const track = h.integration.getRawTrack();
	await expect(h.integration.prepare(() => false)).rejects.toBeInstanceOf(MicPipelineSupersededError);
	h.integration.syncInputs();
	expect((await h.integration.start()).status).toBe('started');
	expect(h.integration.getRawTrack()).toBe(track);
	expect(h.captures).toHaveLength(1);
	dispose();
});

it('re-evaluates current waiters when their earlier owner retires after they requested capture', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const capture = deferred<MediaStream>();
	h.captureResults.push(capture.promise);
	let current = true;
	const old = h.integration.start(() => current);
	await flush();
	const successor = h.integration.start(() => true);
	current = false;
	capture.resolve(createStream());
	expect((await old).status).toBe('superseded');
	expect((await successor).status).toBe('started');
	expect(h.captures).toHaveLength(2);
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});

it('restore captures for its requested channel before UI publication and survives attempt completion', async () => {
	const h = createHarness();
	const dispose = h.mount();
	h.inputs.currentVoiceChannelId = undefined;
	let current = true;
	const prepared = await h.integration.prepare(() => current, 1);
	await h.integration.publish(prepared, () => current);
	h.inputs.currentVoiceChannelId = 1;
	current = false;
	h.integration.syncInputs();
	expect((await h.integration.start()).status).toBe('started');
	expect(h.captures).toHaveLength(1);
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});

it('recovers a capture already ended before its loss listener could be attached', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const ended = createStream();
	ended.track.stop();
	h.captureResults.push(Promise.resolve(ended));
	expect((await h.integration.start()).status).toBe('started');
	expect(h.captures).toHaveLength(2);
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});

for (const processing of ['gain', 'wasm'] as const) {
	for (const talkHeld of [false, true]) {
		it(`fails closed immediately on ${processing} output loss during publication with talk held ${talkHeld}`, async () => {
			const h = createHarness();
			const dispose = h.mount();
			try {
				h.state.micMuted = talkHeld;
				h.state.talkHeld = talkHeld;
				if (processing === 'gain') h.volumeChange(70);
				else h.inputs.devices = { ...h.inputs.devices, wasmNoiseSuppressionEnabled: true };
				const publication = deferred<Producer<AppData>>();
				h.publicationResults.push(publication.promise);
				const starting = h.integration.start();
				await flush();
				const output = h.publications[0]?.options.track;
				if (!output) throw Error('Missing pending publication track');
				const ended = output.onended;
				expect(ended).toBeFunction();
				output.stop();
				for (let repeat = 0; repeat < 5; repeat += 1) ended?.call(output, new Event('ended'));
				expect(h.state.micMuted).toBe(true);
				expect(h.state.talkHeld).toBe(false);
				expect(h.integration.getRawTrack()).toBeUndefined();
				expect(h.streams[0]?.track.readyState).toBe('ended');
				expect(h.state.terminalMutes).toBe(1);
				expect(h.errors).toEqual(['Microphone capture stopped. Unmute to try again.']);
				const producer = createProducer('late-ended-output');
				publication.resolve(producer);
				expect((await starting).status).not.toBe('started');
				await flush();
				for (let update = 0; update < 3; update += 1) h.integration.syncInputs();
				await flush();
				expect(producer.closed).toBe(true);
				expect(h.captures).toHaveLength(1);
				expect(h.state.terminalMutes).toBe(1);
				expect(h.errors).toHaveLength(1);
			} finally {
				dispose();
			}
		});
	}
}
it('a retired processed output callback cannot mute pending successor publication', async () => {
	const h = createHarness();
	const dispose = h.mount();
	try {
		h.volumeChange(70);
		await h.integration.start();
		const oldOutput = h.publications[0]?.options.track;
		if (!oldOutput) throw Error('Missing output');
		const oldEnd = oldOutput.onended;
		await h.integration.cleanup();
		const publication = deferred<Producer<AppData>>();
		h.publicationResults.push(publication.promise);
		const starting = h.integration.start();
		await flush();
		oldEnd?.call(oldOutput, new Event('ended'));
		expect(h.state.terminalMutes).toBe(0);
		expect(h.integration.getRawTrack()?.readyState).toBe('live');
		publication.resolve(createProducer('successor-output'));
		expect((await starting).status).toBe('started');
		expect(h.errors).toEqual([]);
	} finally {
		dispose();
	}
});

it('restarts and republishes capture for an unmuted user when SPEAK is revoked and then restored', async () => {
	const h = createHarness();
	const dispose = h.mount();
	expect((await h.integration.start()).status).toBe('started');
	expect(h.captures).toHaveLength(1);
	const publishedBefore = h.publications.length;
	expect(publishedBefore).toBeGreaterThan(0);
	h.integration.syncInputs();
	h.inputs.canSpeak = false;
	h.integration.syncInputs();
	await flush();
	expect(h.integration.getRawTrack()?.readyState).not.toBe('live');
	h.inputs.canSpeak = true;
	h.integration.syncInputs();
	await flush();
	expect(h.captures).toHaveLength(2);
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	expect(h.publications.length).toBe(publishedBefore + 1);
	dispose();
});

it('does not open an unpublished capture when a listen-only join is granted SPEAK', async () => {
	const h = createHarness();
	h.inputs.canSpeak = false;
	const dispose = h.mount();
	h.integration.syncInputs();
	await expect(h.integration.prepare(() => true, 1)).rejects.toBeInstanceOf(MicPipelineSupersededError);
	h.inputs.canSpeak = true;
	h.integration.syncInputs();
	await flush();
	expect(h.captures).toHaveLength(0);
	expect(h.publications).toHaveLength(0);
	dispose();
});

it('does not start capture on a SPEAK change while muted', async () => {
	const h = createHarness();
	const dispose = h.mount();
	h.state.micMuted = true;
	await h.integration.start();
	h.integration.syncInputs();
	h.inputs.canSpeak = false;
	h.integration.syncInputs();
	await flush();
	h.inputs.canSpeak = true;
	h.integration.syncInputs();
	await flush();
	expect(h.captures).toHaveLength(0);
	dispose();
});
