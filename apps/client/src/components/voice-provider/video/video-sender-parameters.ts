// Chromium validates every setParameters() call against the codec that was
// actually negotiated, while getParameters() keeps echoing the scalabilityMode
// requested at publish time even when that codec cannot encode it. Windows
// hardware H264 (High profile) rejects our L1T3 this way, so a plain
// read-modify-write of an unrelated field (degradationPreference, the screen
// share resolution floor) fails with InvalidModificationError on every call.
//
// Retry once with single-layer L1T1, the one mode every codec must support.
// Later writes read back L1T1 and succeed directly.
const FALLBACK_SCALABILITY_MODE = 'L1T1';

// TypeScript's DOM lib does not declare the WebRTC-SVC encoding field yet.
type TScalableEncoding = RTCRtpEncodingParameters & { scalabilityMode?: string };

type TVideoSenderParametersUpdate = (params: RTCRtpSendParameters) => boolean;

type TVideoSenderParametersResult = {
	updated: boolean;
	scalabilityModeFallback: boolean;
};

const usesLayeredScalabilityMode = (encoding: TScalableEncoding) =>
	encoding.scalabilityMode !== undefined && encoding.scalabilityMode !== FALLBACK_SCALABILITY_MODE;

const isInvalidModificationError = (error: unknown) =>
	typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'InvalidModificationError';

// `update` mutates the freshly read parameters and returns false when there is
// nothing to write. Each attempt keeps getParameters/setParameters free of
// awaits in between: they are coupled by transactionId, and any other
// setParameters landing on this sender in between rejects with
// InvalidStateError.
const updateVideoSenderParameters = async (
	sender: RTCRtpSender,
	update: TVideoSenderParametersUpdate,
): Promise<TVideoSenderParametersResult> => {
	const params = sender.getParameters();

	if (!update(params)) {
		return { updated: false, scalabilityModeFallback: false };
	}

	try {
		await sender.setParameters(params);
		return { updated: true, scalabilityModeFallback: false };
	} catch (error) {
		if (!isInvalidModificationError(error) || !params.encodings.some(usesLayeredScalabilityMode)) {
			throw error;
		}
	}

	const retryParams = sender.getParameters();

	if (!update(retryParams)) {
		return { updated: false, scalabilityModeFallback: false };
	}

	for (const encoding of retryParams.encodings) {
		const scalableEncoding: TScalableEncoding = encoding;

		if (usesLayeredScalabilityMode(scalableEncoding)) {
			scalableEncoding.scalabilityMode = FALLBACK_SCALABILITY_MODE;
		}
	}

	await sender.setParameters(retryParams);

	return { updated: true, scalabilityModeFallback: true };
};

export { updateVideoSenderParameters };
