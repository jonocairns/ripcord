import type { RtpCapabilities } from 'mediasoup-client/types';

// RTP capabilities of the loaded mediasoup device. The provider builds this
// before remote media and the video owners, which read it when they retry,
// consume or choose a codec. The session runtime is its only writer and checks
// currency before each write, so an obsolete init or rebuild cannot replace a
// successor's value. This is deliberately separate from the runtime's React
// publication, which is cleared during rebuild and set only once both transports
// exist, because it drives render-time consume, repair and event runners.
const createDeviceRtpCapabilities = () => {
	let capabilities: RtpCapabilities | null = null;
	return {
		get: (): RtpCapabilities | null => capabilities,
		set: (next: RtpCapabilities | null): void => {
			capabilities = next;
		},
	};
};

type TDeviceRtpCapabilities = ReturnType<typeof createDeviceRtpCapabilities>;

export { createDeviceRtpCapabilities, type TDeviceRtpCapabilities };
