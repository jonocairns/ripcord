import { describe, expect, it } from 'bun:test';
import { updateVideoSenderParameters } from '../video-sender-parameters';

type TScalableSendParameters = RTCRtpSendParameters & {
	encodings: Array<RTCRtpEncodingParameters & { scalabilityMode?: string }>;
};

// Mirrors Chromium: getParameters echoes the scalabilityMode requested at
// publish time, while setParameters validates it against the negotiated codec.
// Each getParameters issues a fresh transactionId, and setParameters rejects
// with InvalidStateError unless it is passed the latest unused one.
const createSender = (supportedModes: readonly string[], scalabilityMode = 'L1T3') => {
	let current: TScalableSendParameters = {
		transactionId: 'tx-0',
		encodings: [{ scalabilityMode }],
		codecs: [],
		headerExtensions: [],
		rtcp: {},
	};
	let reads = 0;
	let pendingTransactionId: string | undefined;
	const writes: RTCRtpSendParameters[] = [];
	const sender = {
		getParameters: () => {
			reads += 1;
			pendingTransactionId = `tx-${reads}`;
			return structuredClone({ ...current, transactionId: pendingTransactionId });
		},
		setParameters: async (params: TScalableSendParameters) => {
			writes.push(structuredClone(params));
			const expectedTransactionId = pendingTransactionId;
			pendingTransactionId = undefined;

			if (params.transactionId !== expectedTransactionId) {
				throw new DOMException('Failed to set parameters since the transaction_id', 'InvalidStateError');
			}

			for (const encoding of params.encodings) {
				if (encoding.scalabilityMode && !supportedModes.includes(encoding.scalabilityMode)) {
					throw new DOMException(
						'Attempted to set RtpParameters scalabilityMode to an unsupported value for the current codecs.',
						'InvalidModificationError',
					);
				}
			}
			current = structuredClone(params);
		},
	};

	return { sender: sender as unknown as RTCRtpSender, writes, getCurrent: () => current };
};

const setBalanced = (params: RTCRtpSendParameters) => {
	params.degradationPreference = 'balanced';
	return true;
};

describe('updateVideoSenderParameters', () => {
	it('writes once when the negotiated codec accepts the requested mode', async () => {
		const { sender, writes, getCurrent } = createSender(['L1T1', 'L1T3']);

		expect(await updateVideoSenderParameters(sender, setBalanced)).toEqual({
			updated: true,
			scalabilityModeFallback: false,
		});
		expect(writes).toHaveLength(1);
		expect(getCurrent().encodings[0]?.scalabilityMode).toBe('L1T3');
		expect(getCurrent().degradationPreference).toBe('balanced');
	});

	it('falls back to L1T1 when the negotiated codec rejects the layered mode', async () => {
		const { sender, writes, getCurrent } = createSender(['L1T1']);

		expect(await updateVideoSenderParameters(sender, setBalanced)).toEqual({
			updated: true,
			scalabilityModeFallback: true,
		});
		expect(writes).toHaveLength(2);
		expect(getCurrent().encodings[0]?.scalabilityMode).toBe('L1T1');
		expect(getCurrent().degradationPreference).toBe('balanced');

		// Later updates read back L1T1 and no longer need the retry.
		const result = await updateVideoSenderParameters(sender, (params) => {
			params.degradationPreference = 'maintain-resolution';
			return true;
		});

		expect(result.scalabilityModeFallback).toBe(false);
		expect(writes).toHaveLength(3);
		expect(getCurrent().degradationPreference).toBe('maintain-resolution');
	});

	it('re-reads the parameters for the retry instead of reusing the rejected ones', async () => {
		const { sender, writes } = createSender(['L1T1']);

		await updateVideoSenderParameters(sender, setBalanced);

		expect(writes.map((write) => write.transactionId)).toEqual(['tx-1', 'tx-2']);
	});

	it('rethrows when the L1T1 retry is also rejected', async () => {
		const { sender, writes, getCurrent } = createSender([]);

		await expect(updateVideoSenderParameters(sender, setBalanced)).rejects.toMatchObject({
			name: 'InvalidModificationError',
		});
		expect(writes).toHaveLength(2);
		expect(getCurrent().encodings[0]?.scalabilityMode).toBe('L1T3');
	});

	it('skips the write when the update reports nothing to change', async () => {
		const { sender, writes } = createSender(['L1T1']);

		expect(await updateVideoSenderParameters(sender, () => false)).toEqual({
			updated: false,
			scalabilityModeFallback: false,
		});
		expect(writes).toHaveLength(0);
	});

	it('rethrows unrelated setParameters failures without retrying', async () => {
		const { sender, writes } = createSender(['L1T1']);
		sender.setParameters = async (params: RTCRtpSendParameters) => {
			writes.push(params);
			throw new DOMException('stale transaction', 'InvalidStateError');
		};

		await expect(updateVideoSenderParameters(sender, setBalanced)).rejects.toMatchObject({
			name: 'InvalidStateError',
		});
		expect(writes).toHaveLength(1);
	});

	it('rethrows when the rejected encoding is already single-layer', async () => {
		const { sender, writes } = createSender([], 'L1T1');

		await expect(updateVideoSenderParameters(sender, setBalanced)).rejects.toMatchObject({
			name: 'InvalidModificationError',
		});
		expect(writes).toHaveLength(1);
	});
});
