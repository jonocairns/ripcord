import type { TRemoteProducerIds } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import type { TExternalStreamTrackPresence } from './use-pending-streams';

type TExistingProducersSweepRequest = {
	rtpCapabilities: RtpCapabilities;
	externalStreamTracks?: TExternalStreamTrackPresence;
	prefetchedProducers?: TRemoteProducerIds;
};

type TRunExistingProducersSweep = (request: TExistingProducersSweepRequest) => Promise<void>;

type TExistingProducersSweeper = {
	// Coalesces overlapping existing-producer sweeps onto a single in-flight run.
	schedule: (request: TExistingProducersSweepRequest) => Promise<void>;
	// Drops any in-flight/queued sweep so the caller (e.g. transport cleanup on
	// reconnect) starts the next sweep generation from a clean slate. A sweep
	// that later settles cannot clobber a newer generation because its finalizer
	// only clears state it still owns.
	reset: () => void;
};

/**
 * Single-flights existing-producer sweeps.
 *
 * - A sweep carrying `prefetchedProducers` (startup / rejoin) joins an active
 *   sweep rather than running a redundant pass.
 * - A sweep without `prefetchedProducers` (reconnect/repair) is coalesced into a
 *   single queued slot (latest wins) and drained after the active sweep settles.
 * - When a sweep settles it clears the in-flight slot only if it still owns it,
 *   so a stalled sweep can never strand the slot across a `reset()`.
 */
const createExistingProducersSweeper = (
	runSweep: TRunExistingProducersSweep,
	log?: (message: string) => void,
): TExistingProducersSweeper => {
	let inFlight: Promise<void> | undefined;
	let queued: Omit<TExistingProducersSweepRequest, 'prefetchedProducers'> | undefined;

	const schedule = (request: TExistingProducersSweepRequest): Promise<void> => {
		const activeSweep = inFlight;

		if (activeSweep) {
			if (request.prefetchedProducers === undefined) {
				queued = {
					rtpCapabilities: request.rtpCapabilities,
					externalStreamTracks: request.externalStreamTracks,
				};
				log?.('Queued existing producer sync behind active sweep');
			} else {
				log?.('Joining active existing producer sync');
			}

			return activeSweep;
		}

		const runQueuedSweeps = async () => {
			let nextSweep: TExistingProducersSweepRequest | undefined = request;

			while (nextSweep !== undefined) {
				const currentSweep = nextSweep;
				nextSweep = undefined;

				await runSweep(currentSweep);

				const queuedSweep = queued;
				queued = undefined;

				if (queuedSweep !== undefined) {
					nextSweep = queuedSweep;
				}
			}
		};

		const sweepPromise = runQueuedSweeps().finally(() => {
			if (inFlight === sweepPromise) {
				inFlight = undefined;
			}
		});

		inFlight = sweepPromise;

		return sweepPromise;
	};

	const reset = () => {
		inFlight = undefined;
		queued = undefined;
	};

	return { schedule, reset };
};

export type { TExistingProducersSweeper, TExistingProducersSweepRequest, TRunExistingProducersSweep };
export { createExistingProducersSweeper };
