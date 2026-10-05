import type { Producer } from 'mediasoup-client/types';

type TVideoSenderMetadata = { configuredMaxBitrate: number | null; label: string };
type TVideoSenderSource = { getProducer: () => Pick<Producer, 'rtpSender'> | undefined; label: string };

// Stats sample current owners, including after republishing, without maintaining
// another producer ref. Chromium exposes SSRC at runtime beyond the DOM type.
const collectVideoSenderMetadata = (sources: TVideoSenderSource[]): Map<number, TVideoSenderMetadata> => {
	const metadata = new Map<number, TVideoSenderMetadata>();
	for (const { getProducer, label } of sources) {
		const sender = getProducer()?.rtpSender;
		if (!sender) continue;
		for (const encoding of sender.getParameters().encodings ?? []) {
			if ('ssrc' in encoding && typeof encoding.ssrc === 'number') {
				metadata.set(encoding.ssrc, {
					configuredMaxBitrate: typeof encoding.maxBitrate === 'number' ? encoding.maxBitrate : null,
					label,
				});
			}
		}
	}
	return metadata;
};

export { collectVideoSenderMetadata };
