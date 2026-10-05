import { describe, expect, it } from 'bun:test';
import { collectVideoSenderMetadata } from '../video-sender-metadata';

const producer = (encodings: (RTCRtpEncodingParameters & { ssrc?: number })[]) => ({
	rtpSender: { getParameters: () => ({ encodings }) } as RTCRtpSender,
});

describe('video sender metadata', () => {
	it('labels every primary encoding using owner getters and retains bitrate ceilings', () => {
		const metadata = collectVideoSenderMetadata([
			{
				label: 'Screen share',
				getProducer: () =>
					producer([
						{ ssrc: 7, maxBitrate: 1000 },
						{ ssrc: 8, maxBitrate: 2000 },
					]),
			},
			{ label: 'Webcam', getProducer: () => producer([{ ssrc: 9 }]) },
		]);
		expect([...metadata]).toEqual([
			[7, { label: 'Screen share', configuredMaxBitrate: 1000 }],
			[8, { label: 'Screen share', configuredMaxBitrate: 2000 }],
			[9, { label: 'Webcam', configuredMaxBitrate: null }],
		]);
	});
	it('reads replacement producers at sampling time and omits encodings without runtime SSRC', () => {
		let current = producer([{ ssrc: 7, maxBitrate: 1000 }]);
		const sources = [{ label: 'Screen share', getProducer: () => current }];
		expect(collectVideoSenderMetadata(sources).has(7)).toBe(true);
		current = producer([{ ssrc: 8 }, { maxBitrate: 5000 }]);
		expect([...collectVideoSenderMetadata(sources).keys()]).toEqual([8]);
	});
	it('does not retain a producer after the owner detaches it', () => {
		expect(collectVideoSenderMetadata([{ label: 'Webcam', getProducer: () => undefined }]).size).toBe(0);
	});
});
