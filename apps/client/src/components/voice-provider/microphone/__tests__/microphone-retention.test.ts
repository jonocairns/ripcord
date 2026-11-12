import { expect, it } from 'bun:test';
import { createOwnMicControls } from '../../own-mic-controls';
import { recoverTransportMicrophone } from '../../session/transport-recovery-microphone';
import { createHarness, flush } from './microphone-integration-fixture';

const controlsFor = (h: ReturnType<typeof createHarness>, resets: number[]) =>
	createOwnMicControls({
		getIntent: () => ({ micMuted: h.state.micMuted, soundMuted: false }),
		isMicWanted: () => !h.state.micMuted || h.state.talkHeld,
		isMicMutedWithoutTest: () => h.state.micMuted,
		setOwnVoiceIntent: (intent) => {
			if (intent.micMuted !== undefined) h.state.micMuted = intent.micMuted;
		},
		cancelPushHold: () => {
			h.state.talkHeld = false;
		},
		getCurrentVoiceChannelId: () => h.inputs.currentVoiceChannelId,
		hasLiveMicCapture: () => h.integration.getRawTrack()?.readyState === 'live',
		startMicStream: h.integration.start,
		resetMicRecoveryBudget: () => {
			resets.push(1);
			h.integration.resetRawRecoveryBudget();
		},
		beginOperation: () => ++h.state.operation,
		playSound: () => {},
	});

it('R3-1 press, release, press retains capture and producer without resetting the live recovery budget', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const resets: number[] = [];
	h.state.micMuted = true;
	const controls = controlsFor(h, resets);
	await controls.ensureMicStarted();
	expect(h.captures).toHaveLength(0);
	for (let press = 0; press < 2; press++) {
		h.state.talkHeld = true;
		h.integration.setMuted(false);
		await controls.ensureMicStarted({ resetRecoveryBudget: true });
		h.state.talkHeld = false;
		h.integration.setMuted(true);
		await flush();
		expect(h.integration.getRawTrack()?.readyState).toBe('live');
		expect(h.inputs.localAudioStream?.getAudioTracks()[0]?.enabled).toBe(false);
	}
	expect(h.captures).toHaveLength(1);
	expect(h.producers).toHaveLength(1);
	expect(h.closedOnServer).toEqual([]);
	expect(resets).toHaveLength(1);
	dispose();
});

it('republishes muted live capture after transport recovery', async () => {
	const h = createHarness();
	const dispose = h.mount();
	await h.integration.start();
	const track = h.integration.getRawTrack();
	h.state.micMuted = true;
	h.integration.setMuted(true);
	await flush();
	h.newTransport();
	expect(
		await recoverTransportMicrophone(
			{ recoveryJoined: false, micMuted: true, canSpeak: true, hasCurrentStream: true, currentTrackLive: true },
			{
				start: h.integration.start,
				publishCurrent: () => h.integration.publish('current'),
				discardCurrent: h.integration.cleanup,
				onStartFailed: () => {
					throw Error('unexpected start failure');
				},
			},
		),
	).toBe('published-current');
	expect(h.integration.getRawTrack()).toBe(track);
	expect(h.captures).toHaveLength(1);
	expect(h.publications.at(-1)?.options.track?.enabled).toBe(false);
	dispose();
});

it('R3-2 failed unmute reports the real error and commits exactly once through the reconciler', async () => {
	const h = createHarness();
	const dispose = h.mount();
	h.state.micMuted = true;
	h.captureResults.push(Promise.reject(Error('Permission denied')));
	await controlsFor(h, []).setMicMuted(false);
	await flush();
	expect(h.errors).toEqual(['Permission denied']);
	expect(h.state.terminalMutes).toBe(1);
	dispose();
});

for (const phase of ['prepare', 'publish'] as const)
	for (const current of [false, true])
		it(`R3-3 reconciler owns ${phase} failure with operation current=${current}`, async () => {
			const h = createHarness();
			const dispose = h.mount();
			let reject: (error: Error) => void = () => {};
			const pending = new Promise<never>((_resolve, no) => {
				reject = no;
			});
			if (phase === 'prepare') h.captureResults.push(pending);
			else h.publicationResults.push(pending);
			const result =
				phase === 'prepare'
					? h.integration.prepare().catch(() => {})
					: h.integration
							.prepare()
							.then((p) => h.integration.publish(p))
							.catch(() => {});
			await flush();
			if (!current) h.state.operation++;
			reject(Error('NotReadableError'));
			await result;
			await flush();
			expect(h.state.terminalMutes).toBe(current ? 1 : 0);
			expect(h.errors).toEqual(current ? ['NotReadableError'] : []);
			dispose();
		});

for (const phase of ['prepare', 'publish'] as const)
	it(`R3-4 no SPEAK skips ${phase} without changing intent or notifying`, async () => {
		const h = createHarness();
		const dispose = h.mount();
		h.inputs.canSpeak = false;
		await h.integration
			.prepare(() => true, 1)
			.then((p) => h.integration.publish(p))
			.catch(() => {});
		expect(h.captures).toHaveLength(0);
		expect(h.publications).toHaveLength(0);
		expect(h.state.micMuted).toBe(false);
		expect(h.state.terminalMutes).toBe(0);
		expect(h.errors).toEqual([]);
		dispose();
	});

it('deafen and undeafen keep the same raw capture and producer', async () => {
	const h = createHarness();
	const dispose = h.mount();
	await h.integration.start();
	const raw = h.integration.getRawTrack();
	h.state.gateOpen = false;
	h.state.micMuted = true;
	h.integration.setMuted(true);
	await flush();
	expect(h.integration.getRawTrack()).toBe(raw);
	expect(raw?.readyState).toBe('live');
	h.state.gateOpen = true;
	h.state.micMuted = false;
	h.integration.setMuted(false);
	await h.integration.start();
	expect(h.integration.getRawTrack()).toBe(raw);
	expect(h.producers).toHaveLength(1);
	expect(h.closedOnServer).toEqual([]);
	dispose();
});

for (const phase of ['prepare', 'publish'] as const)
	it(`permission revoked during ${phase} failure preserves intent without a toast`, async () => {
		const h = createHarness();
		const dispose = h.mount();
		let reject: (error: Error) => void = () => {};
		const pending = new Promise<never>((_resolve, no) => {
			reject = no;
		});
		if (phase === 'prepare') h.captureResults.push(pending);
		else h.publicationResults.push(pending);
		const result = h.integration
			.prepare(() => true, 9)
			.then((p) => h.integration.publish(p))
			.catch(() => {});
		await flush();
		h.inputs.canSpeak = false;
		reject(Error('Insufficient channel permissions'));
		await result;
		await flush();
		expect(h.state.micMuted).toBe(false);
		expect(h.state.terminalMutes).toBe(0);
		expect(h.errors).toEqual([]);
		expect(h.integration.getRawTrack()).toBeUndefined();
		dispose();
	});

it('transport start retries a stale failure inside reconciliation without caller failure commits', async () => {
	const h = createHarness();
	const dispose = h.mount();
	let reject: (error: Error) => void = () => {};
	h.captureResults.push(
		new Promise<never>((_resolve, no) => {
			reject = no;
		}),
	);
	const recovering = recoverTransportMicrophone(
		{ recoveryJoined: false, micMuted: false, canSpeak: true, hasCurrentStream: false, currentTrackLive: false },
		{
			start: h.integration.start,
			publishCurrent: () => h.integration.publish('current'),
			discardCurrent: h.integration.cleanup,
			onStartFailed: () => {
				throw Error('stale failure escaped reconciler');
			},
		},
	);
	await flush();
	h.state.operation++;
	reject(Error('stale transport start'));
	expect(await recovering).toBe('started');
	expect(h.captures).toHaveLength(2);
	expect(h.producers).toHaveLength(1);
	expect(h.errors).toEqual([]);
	expect(h.state.terminalMutes).toBe(0);
	dispose();
});

it('a failed first talk start cancels the hold through the sole failure handler', async () => {
	const h = createHarness();
	const dispose = h.mount();
	h.state.micMuted = true;
	h.state.talkHeld = true;
	h.captureResults.push(Promise.reject(Error('Permission denied')));
	await controlsFor(h, []).ensureMicStarted({ resetRecoveryBudget: true });
	expect(h.state.talkHeld).toBe(false);
	expect(h.state.micMuted).toBe(true);
	expect(h.errors).toEqual(['Permission denied']);
	expect(h.state.terminalMutes).toBe(1);
	dispose();
});
