import { describe, expect, it } from 'bun:test';
import { updateVideoSenderParameters } from '../video-sender-parameters';

type TScalableSendParameters = RTCRtpSendParameters & {
	encodings: Array<RTCRtpEncodingParameters & { scalabilityMode?: string }>;
};

// Mirrors Chromium: getParameters echoes the scalabilityMode requested at
// publish time, while setParameters validates it against the negotiated codec.
const createSender = (supportedModes: readonly string[], scalabilityMode = 'L1T3') => {
	let current: TScalableSendParameters = {
		transactionId: 'tx',
		encodings: [{ scalabilityMode }],
		codecs: [],
		headerExtensions: [],
		rtcp: {},
	};
	const writes: RTCRtpSendParameters[] = [];
	const sender = {
		getParameters: () => structuredClone(current),
		setParameters: async (params: TScalableSendParameters) => {
			writes.push(structuredClone(params));
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
