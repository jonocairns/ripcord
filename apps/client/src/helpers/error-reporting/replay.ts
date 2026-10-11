type TReplay = { getRecordingMode: () => string | undefined; flush: () => Promise<void> };
// Server forwarding suppresses SDK afterSendEvent. Retain its opt-in on-error
// probability for buffered, masked replay without transmitting the error twice.
export const flushErrorReplay = (replay: TReplay | undefined, sampleRate: number, random = Math.random): void => {
	try {
		if (sampleRate > 0 && replay?.getRecordingMode() === 'buffer' && random() < sampleRate)
			void replay.flush().catch(() => {});
	} catch {
		/* Replay cannot affect the error path. */
	}
};
