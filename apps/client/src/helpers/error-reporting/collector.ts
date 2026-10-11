import { diagnosticRecordSchema, type TDiagnosticBatch, type TDiagnosticRecord } from '@sharkord/shared';

type TCollectorOptions = {
	upload: (batch: TDiagnosticBatch, signal: AbortSignal) => Promise<void>;

	createId: () => string;
	now?: () => number;
	schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
	cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};

// At most 64 records in memory, eight per request, one request every two seconds.
// A failed batch is abandoned after three attempts; diagnostics never block media.
export const createDiagnosticCollector = (options: TCollectorOptions) => {
	const now = options.now ?? Date.now;
	const schedule = options.schedule ?? setTimeout;
	const cancel = options.cancel ?? clearTimeout;
	let identity: string | undefined;
	let clientSessionId: string | undefined;
	let authenticated = false;
	let supported = false;
	let generation = 0;
	let sequence = 0;
	let droppedEvents = 0;
	let queue: TDiagnosticRecord[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: AbortController | undefined;
	let inFlightSequences = new Set<number>();

	let attempts = 0;
	let retrySequences = new Set<number>();
	let disposed = false;
	let upload = options.upload;

	const clearTimer = () => {
		if (timer !== undefined) cancel(timer);
		timer = undefined;
	};
	const reset = () => {
		authenticated = false;
		generation += 1;
		clearTimer();
		inFlight?.abort();
		inFlight = undefined;
		inFlightSequences.clear();

		queue = [];
		attempts = 0;
		retrySequences.clear();
		droppedEvents = 0;
		sequence = 0;
		clientSessionId = undefined;
	};
	const planFlush = (delay = 2_000) => {
		if (disposed || timer !== undefined || inFlight || !authenticated || !supported || queue.length === 0) return;
		timer = schedule(() => {
			timer = undefined;
			void flush();
		}, delay);
	};
	const flush = async (timeoutMs = 5_000) => {
		if (disposed || inFlight || !authenticated || !supported || !clientSessionId) return;
		const fresh = queue.filter((event) => now() - event.occurredAt <= 300_000);
		droppedEvents += queue.length - fresh.length;
		queue = fresh;
		const retryBatch = queue.filter((event) => retrySequences.has(event.sequence));
		// Retry the same sequence set. Expiry or overflow creates a new batch
		// with its own budget; newly queued events cannot inherit old failures.
		if (retryBatch.length !== retrySequences.size) attempts = 0;
		const batch = retryBatch.length > 0 ? retryBatch : queue.slice(0, 8);
		retrySequences = new Set(batch.map((event) => event.sequence));
		if (batch.length === 0) {
			attempts = 0;
			return;
		}
		const batchGeneration = generation;
		const batchUpload = upload;
		const payload: TDiagnosticBatch = {
			clientSessionId,

			droppedEvents,
			records: batch,
		};
		const controller = new AbortController();
		inFlight = controller;
		inFlightSequences = new Set(batch.map((event) => event.sequence));
		const timeout = schedule(() => controller.abort(), timeoutMs);
		const dropBatch = () => {
			const sequences = new Set(batch.map((event) => event.sequence));
			queue = queue.filter((event) => !sequences.has(event.sequence));
		};
		try {
			// Race abort as well: an uploader may ignore cancellation. The network
			// adapter must also release its request subscription on abort.
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => reject(new Error('Diagnostics upload cancelled'));
				controller.signal.addEventListener('abort', onAbort, { once: true });
				Promise.resolve()
					.then(() => {
						if (controller.signal.aborted || batchGeneration !== generation || !authenticated)
							throw new Error('Diagnostics upload cancelled');
						return batchUpload(payload, controller.signal);
					})
					.then(resolve, reject)
					.finally(() => {
						controller.signal.removeEventListener('abort', onAbort);
					});
			});
			if (batchGeneration !== generation) return;
			dropBatch();
			retrySequences.clear();
			attempts = 0;
			droppedEvents = Math.max(0, droppedEvents - payload.droppedEvents);
		} catch {
			if (batchGeneration !== generation) return;
			if (authenticated) attempts += 1;
			if (attempts >= 3) {
				dropBatch();
				retrySequences.clear();
				droppedEvents += batch.length;
				attempts = 0;
			}
		} finally {
			cancel(timeout);
			if (batchGeneration === generation) {
				inFlight = undefined;
				inFlightSequences.clear();
				planFlush(attempts > 0 ? 2_000 * attempts : 2_000);
			}
		}
	};

	return {
		configure: (nextIdentity: string, featureSupported: boolean, nextUpload = options.upload) => {
			if (disposed) return;
			if (identity !== nextIdentity || supported !== featureSupported) reset();
			identity = nextIdentity;
			upload = nextUpload;
			supported = featureSupported;
			if (supported && !clientSessionId) clientSessionId = options.createId();
		},
		authenticate: () => {
			authenticated = true;
			planFlush();
		},
		pause: () => {
			authenticated = false;
			clearTimer();
			inFlight?.abort();
		},
		record: (details: Omit<TDiagnosticRecord, 'sequence'>) => {
			try {
				if (disposed || !authenticated || !supported || !identity) return;
				const parsed = diagnosticRecordSchema.safeParse({ ...details, sequence: sequence + 1 });
				if (!parsed.success) return;
				sequence += 1;
				queue.push(parsed.data);
				if (queue.length > 64) {
					// Preserve dispatched events until acknowledgement/retry exhaustion.
					// Dropping them here would count successfully delivered data as lost.
					const discardIndex = queue.findIndex((event) => !inFlightSequences.has(event.sequence));
					if (discardIndex >= 0) queue.splice(discardIndex, 1);
					droppedEvents += 1;
				}
				planFlush();
			} catch {
				/* Observability cannot affect its caller. */
			}
		},
		flush,
		clear: () => {
			authenticated = false;
			supported = false;
			identity = undefined;
			reset();
		},
		dispose: () => {
			disposed = true;
			reset();
		},
	};
};
