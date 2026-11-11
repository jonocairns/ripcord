type TProducerSubscription = 'newProducer' | 'producerClosed';
type TProducerSyncReason = 'acknowledged' | 'fallback';

type TProducerSyncGateOptions = {
	// 'acknowledged': both producer listeners are attached on the socket that is
	// live now. 'fallback': no such proof; this is the unordered snapshot that
	// clients up to 2.5.9 take.
	sync: (reason: TProducerSyncReason) => void;
	// False once the tRPC client this effect run subscribed on has been retired.
	isCurrentClient: () => boolean;
	fallbackMs: number;
	// Starts a one-shot timer and returns the function that cancels it.
	schedule: (callback: () => void, delayMs: number) => () => void;
};

// A server that is alive but has not acknowledged a subscription for this long
// gets a best-effort snapshot. Released servers normally acknowledge within
// one round trip; a stalled subscription can still reach this fallback.
const PRODUCER_SYNC_ACK_FALLBACK_MS = 20_000;

// Runs `sync('acknowledged')` once, after the server has acknowledged both
// producer subscriptions on one socket. tRPC acknowledges a subscription only
// after its listener is attached, so a snapshot requested then cannot fall
// between "snapshot taken" and "listener attached". tRPC re-sends live
// subscriptions after a reconnect, so an acknowledgement is only good for the
// socket it came from: every connection-state notification discards the ones
// collected so far.
const createProducerSyncAfterSubscriptionStart = ({
	sync,
	isCurrentClient,
	fallbackMs,
	schedule,
}: TProducerSyncGateOptions) => {
	const started = new Set<TProducerSubscription>();
	// armed: may still sync. done: the ordered sync ran. dead: an ended
	// subscription, a retired client or the effect cleanup; nothing may sync.
	let status: 'armed' | 'done' | 'dead' = 'armed';
	let fallbackRan = false;
	let cancelFallback = (): void => {};

	const end = (): void => {
		status = 'dead';
		started.clear();
		cancelFallback();
	};

	const runFallback = (): void => {
		if (status !== 'armed' || fallbackRan) return;
		if (!isCurrentClient()) {
			end();
			return;
		}
		fallbackRan = true;
		sync('fallback');
	};

	cancelFallback = schedule(runFallback, fallbackMs);

	return {
		markStarted: (subscription: TProducerSubscription): void => {
			if (status !== 'armed') return;
			if (!isCurrentClient()) {
				end();
				return;
			}
			started.add(subscription);
			if (started.size < 2) return;
			status = 'done';
			cancelFallback();
			sync('acknowledged');
		},
		// Any connection-state notification is a socket boundary.
		markConnectionChanged: (): void => {
			if (status === 'armed') started.clear();
		},
		// A producer subscription errored, completed or was stopped.
		markEnded: (): void => {
			if (status === 'armed') end();
		},
		dispose: end,
	};
};

export { createProducerSyncAfterSubscriptionStart, PRODUCER_SYNC_ACK_FALLBACK_MS };
