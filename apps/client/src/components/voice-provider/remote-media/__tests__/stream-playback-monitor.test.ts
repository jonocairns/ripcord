import { describe, expect, it, mock } from 'bun:test';
import type { TStreamEventDetails } from '@sharkord/shared';
import { getVideoReceiverCounters, monitorScreenPlayback } from '../stream-playback-monitor';

describe('owned receiver playback monitor', () => {
	it('reads only bounded video receive counters and discards addresses/codec details', () => {
		const report = new Map([
			[
				'video',
				{
					type: 'inbound-rtp',
					kind: 'video',
					bytesReceived: 42,
					framesReceived: 3,
					framesDecoded: 2,
					address: 'private',
				},
			],
			['audio', { type: 'inbound-rtp', kind: 'audio', bytesReceived: 99 }],
			['candidate', { type: 'candidate-pair', bytesReceived: 10_000 }],
		]) as unknown as RTCStatsReport;
		expect(getVideoReceiverCounters(report)).toEqual({ bytesReceived: 42, framesReceived: 3, framesDecoded: 2 });
	});
	it('suppresses concealed, paused, detached, ended and unowned video while receiver counters advance', async () => {
		const originalMediaStream = Object.getOwnPropertyDescriptor(globalThis, 'MediaStream');
		class TestMediaStream {
			getVideoTracks() {
				return [{ id: 'track' }];
			}
		}
		Object.defineProperty(globalThis, 'MediaStream', { configurable: true, value: TestMediaStream });
		let dispose: (() => void) | undefined;
		try {
			let time = 0;
			let frames = 1;
			let poll: (() => void) | undefined;
			let onFrame: (() => void) | undefined;
			const events: TStreamEventDetails[] = [];
			const style = { visibility: 'visible', opacity: '1' };
			const document = {
				visibilityState: 'visible',
				defaultView: { getComputedStyle: () => style },
			};
			const video = {
				srcObject: new TestMediaStream(),
				isConnected: true,
				getClientRects: () => [1],
				ownerDocument: document,
				paused: false,
				ended: false,
				requestVideoFrameCallback: (callback: () => void) => {
					onFrame = callback;
					return 1;
				},
				cancelVideoFrameCallback: () => {},
			};
			const track = { id: 'track', readyState: 'live' };
			const consumer = {
				id: 'consumer',
				producerId: 'producer',
				closed: false,
				paused: false,
				track: track as MediaStreamTrack,
				getStats: async () =>
					new Map([
						['video', { type: 'inbound-rtp', kind: 'video', framesReceived: frames, framesDecoded: frames }],
					]) as unknown as RTCStatsReport,
			};
			const settle = async () => {
				for (let index = 0; index < 10; index += 1) await Promise.resolve();
			};
			const advance = async () => {
				time += 3_000;
				frames += 1;
				poll?.();
				await settle();
			};
			dispose = monitorScreenPlayback({
				consumer,
				remoteId: 2,
				getVideoElement: () => video as unknown as HTMLVideoElement,
				transportConnected: () => true,
				emit: (event) => events.push(event),
				now: () => time,
				schedule: (callback) => {
					poll = callback;
					const timer = setInterval(() => {}, 60_000);
					timer.unref();
					return timer;
				},
			});
			await settle();
			onFrame?.();
			await advance();
			expect(events.map((event) => event.event)).toEqual(['playback_first_frame']);
			events.length = 0;
			for (const hide of [
				() => {
					style.opacity = '0';
				},
				() => {
					style.visibility = 'hidden';
				},
				() => {
					document.visibilityState = 'hidden';
				},
				() => {
					video.paused = true;
				},
				() => {
					consumer.paused = true;
				},
				() => {
					video.ended = true;
				},
				() => {
					video.isConnected = false;
				},
				() => {
					video.getClientRects = () => [];
				},
				() => {
					track.readyState = 'ended';
				},
				() => {
					video.srcObject = { getVideoTracks: () => [{ id: 'other-track' }] };
				},
			]) {
				style.opacity = '1';
				style.visibility = 'visible';
				document.visibilityState = 'visible';
				video.paused = false;
				consumer.paused = false;
				video.ended = false;
				video.isConnected = true;
				video.getClientRects = () => [1];
				track.readyState = 'live';
				video.srcObject = new TestMediaStream();
				hide();
				for (let index = 0; index < 12; index += 1) await advance();
				expect(events).toEqual([]);
			}
			video.srcObject = new TestMediaStream();
			for (let index = 0; index < 7; index += 1) await advance();
			expect(events).toMatchObject([{ event: 'playback_stalled', reason: 'no_playback', consumerId: 'consumer' }]);
		} finally {
			dispose?.();
			if (originalMediaStream) Object.defineProperty(globalThis, 'MediaStream', originalMediaStream);
			else Reflect.deleteProperty(globalThis, 'MediaStream');
		}
	});
	it('cancels its poll owner and ignores stats that finish after consumer disposal', async () => {
		let complete: ((report: RTCStatsReport) => void) | undefined;
		const events: TStreamEventDetails[] = [];
		const cancel = mock((timer: ReturnType<typeof setInterval>) => clearInterval(timer));
		const readElement = mock(() => null);
		const dispose = monitorScreenPlayback({
			consumer: {
				id: 'consumer',
				producerId: 'producer',
				closed: false,
				paused: false,
				track: { id: 'track', readyState: 'live' } as MediaStreamTrack,
				getStats: () =>
					new Promise<RTCStatsReport>((resolve) => {
						complete = resolve;
					}),
			},
			remoteId: 2,
			getVideoElement: readElement,
			transportConnected: () => true,
			emit: (event) => {
				events.push(event);
			},
			cancel,
		});
		dispose();
		complete?.(new Map() as RTCStatsReport);
		for (let index = 0; index < 10; index += 1) await Promise.resolve();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(readElement).not.toHaveBeenCalled();
		expect(events).toEqual([]);
	});
});
