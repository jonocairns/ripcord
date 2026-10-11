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
