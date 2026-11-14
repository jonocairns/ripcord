import { describe, expect, it, mock } from 'bun:test';
import type { AppData, Producer } from 'mediasoup-client/types';
import { createCapture, createProducer, deferred, flush } from '../../__tests__/video-controller-fixture';
import { mountScreenShareQualityGuard } from '../screen-share-quality-guard';

describe('screen quality guard production mount', () => {
	it('applies and releases the existing resolution floor through the producer getter', async () => {
		let reason = 'bandwidth';
		let tick = () => {};
		const params = { encodings: [{}] } as RTCRtpSendParameters;
		const setParameters = mock(async (_params: RTCRtpSendParameters) => {});
		const sender = {
			getParameters: () => params,
			setParameters,
			getStats: async () =>
				new Map([['out', { type: 'outbound-rtp', kind: 'video', frameHeight: 180, qualityLimitationReason: reason }]]),
		} as unknown as RTCRtpSender;
		const producer = createProducer('screen', createCapture().videoTrack, sender);
		const dispose = mountScreenShareQualityGuard({
			getProducer: () => producer,
			log: () => {},
			now: () => 0,
			setInterval: (handler) => {
				tick = handler;
				const timer = setInterval(() => {}, 2_000_000_000);
				timer.unref();
				return timer;
			},
			clearInterval,
		});
		for (let i = 0; i < 3; i += 1) {
			tick();
			await flush();
		}
		expect(setParameters).toHaveBeenCalledTimes(1);
		expect(params.degradationPreference).toBe('maintain-resolution');
		expect(params.encodings[0]?.scaleResolutionDownBy).toBe(2);
		reason = 'none';
		for (let i = 0; i < 5; i += 1) {
			tick();
			await flush();
		}
		expect(setParameters).toHaveBeenCalledTimes(2);
		expect(params.degradationPreference).toBe('balanced');
		expect(params.encodings[0]?.scaleResolutionDownBy).toBe(1);
		dispose();
	});
	it.each(['replacement', 'cleanup'])('ignores a stats sample that completes after %s', async (action) => {
		const stats = deferred<RTCStatsReport>();
		let tick = () => {};
		const setParameters = mock(async () => {});
		const sender = { getStats: () => stats.promise, setParameters } as unknown as RTCRtpSender;
		let producer: Producer<AppData> | undefined = createProducer('old', createCapture().videoTrack, sender);
		const dispose = mountScreenShareQualityGuard({
			getProducer: () => producer,
			log: () => {},
			now: () => 0,
			setInterval: (handler) => {
				tick = handler;
				const timer = setInterval(() => {}, 2_000_000_000);
				timer.unref();
				return timer;
			},
			clearInterval,
		});
		tick();
		if (action === 'cleanup') dispose();
		else producer = undefined;
		stats.resolve(new Map() as RTCStatsReport);
		await flush();
		expect(setParameters).not.toHaveBeenCalled();
		dispose();
	});
});

it.each([
	'replacement',
	'cleanup',
])('does not commit a floor adjustment after %s during setParameters', async (action) => {
	let tick = () => {};
	const completed = deferred<void>();
	const log = mock((_message: string, _data?: Record<string, unknown>) => {});
	const sender = {
		getParameters: () => ({ encodings: [{}] }),
		setParameters: () => completed.promise,
		getStats: async () =>
			new Map([
				['out', { type: 'outbound-rtp', kind: 'video', frameHeight: 180, qualityLimitationReason: 'bandwidth' }],
			]),
	} as unknown as RTCRtpSender;
	let producer: Producer<AppData> | undefined = createProducer('old', createCapture().videoTrack, sender);
	const dispose = mountScreenShareQualityGuard({
		getProducer: () => producer,
		log,
		now: () => 0,
		setInterval: (handler) => {
			tick = handler;
			const timer = setInterval(() => {}, 2_000_000_000);
			timer.unref();
			return timer;
		},
		clearInterval,
	});
	for (let i = 0; i < 3; i += 1) {
		tick();
		await flush();
	}
	if (action === 'cleanup') dispose();
	else producer = createProducer('replacement');
	completed.resolve();
	await flush();
	expect(log).not.toHaveBeenCalled();
	dispose();
});

const mountWithManualTicks = (
	getProducer: () => Producer<AppData> | undefined,
	log: (message: string, data?: Record<string, unknown>) => void,
) => {
	let tick = () => {};
	const dispose = mountScreenShareQualityGuard({
		getProducer,
		log,
		now: () => 0,
		setInterval: (handler) => {
			tick = handler;
			const timer = setInterval(() => {}, 2_000_000_000);
			timer.unref();
			return timer;
		},
		clearInterval,
	});
	const runTicks = async (count: number) => {
		for (let i = 0; i < count; i += 1) {
			tick();
			await flush();
		}
	};
	return { dispose, runTicks };
};

it('stops retrying the floor once the sender codec rejects the update', async () => {
	const log = mock((_message: string, _data?: Record<string, unknown>) => {});
	const setParameters = mock(async (_params: RTCRtpSendParameters) => {
		throw new DOMException('Attempted to set RtpParameters scalabilityMode', 'InvalidModificationError');
	});
	const sender = {
		getParameters: () => ({ encodings: [{}], degradationPreference: 'maintain-framerate' }),
		setParameters,
		getStats: async () =>
			new Map([['out', { type: 'outbound-rtp', kind: 'video', frameHeight: 180, qualityLimitationReason: 'cpu' }]]),
	} as unknown as RTCRtpSender;
	const producer = createProducer('screen', createCapture().videoTrack, sender);
	const { dispose, runTicks } = mountWithManualTicks(() => producer, log);

	await runTicks(9);

	expect(setParameters).toHaveBeenCalledTimes(1);
	const unavailable = log.mock.calls.filter(([message]) => message === 'Screen share resolution floor unavailable');
	expect(unavailable).toHaveLength(1);
	expect(unavailable[0]?.[1]).toMatchObject({
		captureHeight: 720,
		floorHeight: 360,
		frameHeight: 180,
		qualityLimitationReason: 'cpu',
		degradationPreference: 'maintain-framerate',
	});
	expect(log.mock.calls.some(([message]) => message === 'Failed to apply screen share resolution floor')).toBe(false);
	dispose();
});

it('reports one sender stats snapshot about 20 seconds after publish', async () => {
	const log = mock((_message: string, _data?: Record<string, unknown>) => {});
	const sender = {
		getParameters: () => ({ encodings: [{}], degradationPreference: 'balanced' }),
		setParameters: mock(async () => {}),
		getStats: async () =>
			new Map<string, Record<string, unknown>>([
				[
					'out',
					{
						type: 'outbound-rtp',
						kind: 'video',
						codecId: 'codec-1',
						frameWidth: 1280,
						frameHeight: 720,
						framesPerSecond: 29.7,
						targetBitrate: 2_500_000.4,
						qualityLimitationReason: 'none',
						encoderImplementation: 'D3D12VideoEncodeAccelerator',
						powerEfficientEncoder: true,
						scalabilityMode: 'L1T1',
					},
				],
				['codec-1', { type: 'codec', mimeType: 'video/H264' }],
			]),
	} as unknown as RTCRtpSender;
	const producer = createProducer('screen', createCapture().videoTrack, sender);
	const { dispose, runTicks } = mountWithManualTicks(() => producer, log);

	await runTicks(9);
	expect(log).not.toHaveBeenCalled();

	await runTicks(5);

	expect(log).toHaveBeenCalledTimes(1);
	expect(log).toHaveBeenCalledWith('Screen share sender stats', {
		captureHeight: 720,
		frameWidth: 1280,
		frameHeight: 720,
		framesPerSecond: 30,
		targetBitrate: 2_500_000,
		qualityLimitationReason: 'none',
		encoderImplementation: 'D3D12VideoEncodeAccelerator',
		powerEfficientEncoder: true,
		scalabilityMode: 'L1T1',
		mimeType: 'video/H264',
		degradationPreference: 'balanced',
	});
	dispose();
});

const createLimitedSender = (error: Error) => {
	const setParameters = mock(async (_params: RTCRtpSendParameters) => {
		throw error;
	});
	const sender = {
		getParameters: () => ({ encodings: [{}] }),
		setParameters,
		getStats: async () =>
			new Map([['out', { type: 'outbound-rtp', kind: 'video', frameHeight: 180, qualityLimitationReason: 'cpu' }]]),
	} as unknown as RTCRtpSender;
	return { sender, setParameters };
};

it('tries the floor again for a replacement producer after a codec rejection', async () => {
	const rejected = createLimitedSender(new DOMException('rejected', 'InvalidModificationError'));
	const replacement = createLimitedSender(new DOMException('rejected', 'InvalidModificationError'));
	let producer = createProducer('first', createCapture().videoTrack, rejected.sender);
	const { dispose, runTicks } = mountWithManualTicks(
		() => producer,
		() => {},
	);

	await runTicks(6);
	expect(rejected.setParameters).toHaveBeenCalledTimes(1);

	producer = createProducer('second', createCapture().videoTrack, replacement.sender);
	await runTicks(3);

	expect(replacement.setParameters).toHaveBeenCalledTimes(1);
	dispose();
});

it('keeps retrying the floor after a transient sender error', async () => {
	const log = mock((_message: string, _data?: Record<string, unknown>) => {});
	const { sender, setParameters } = createLimitedSender(new DOMException('busy', 'InvalidStateError'));
	const producer = createProducer('screen', createCapture().videoTrack, sender);
	const { dispose, runTicks } = mountWithManualTicks(() => producer, log);

	await runTicks(6);

	expect(setParameters).toHaveBeenCalledTimes(2);
	expect(
		log.mock.calls.filter(([message]) => message === 'Failed to apply screen share resolution floor'),
	).toHaveLength(2);
	expect(log.mock.calls.some(([message]) => message === 'Screen share resolution floor unavailable')).toBe(false);
	dispose();
});
