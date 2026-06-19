// Client-authoritative speaking is treated as a low-latency *hint*, not a
// permanent ownership transfer. Each accepted report grants the user a short
// lease during which the server observer defers to the client; when reports (or
// valid stats) stop, the lease expires and the observer resumes as the
// canonical source. This module is the pure decision logic so it can be unit
// tested without a live runtime.

// How long a single accepted report suppresses the server observer for a user.
// Reports fire on transitions, so during steady speech/silence the lease lapses
// and the observer (which agrees in steady state) takes back over; the next
// transition re-establishes the lease for instant feedback.
const CLIENT_VOICE_ACTIVITY_LEASE_MS = 1_000;

type ClientVoiceActivityLease = {
	producerId: string;
	expiresAt: number;
};

type ClientVoiceActivityOrdering = {
	producerId: string;
	lastSeq: number;
};

type ClientVoiceActivityReport = {
	producerId: string;
	seq: number;
	isSpeaking: boolean;
};

type ClientVoiceActivityContext = {
	// The id of the user's current audio producer, or undefined if none.
	currentProducerId: string | undefined;
	micMuted: boolean;
	now: number;
};

type ClientVoiceActivityDecision =
	| { accept: false }
	| {
			accept: true;
			isSpeaking: boolean;
			lease: ClientVoiceActivityLease;
			ordering: ClientVoiceActivityOrdering;
	  };

// Decides whether a client-reported speaking transition should be applied, and
// the lease it produces. Rejects reports that aren't bound to the user's current
// audio producer, `true` reports from a muted user, and reordered reports within
// the same producer's lease.
const resolveClientVoiceActivity = (
	currentOrdering: ClientVoiceActivityOrdering | undefined,
	report: ClientVoiceActivityReport,
	context: ClientVoiceActivityContext,
	leaseMs: number = CLIENT_VOICE_ACTIVITY_LEASE_MS,
): ClientVoiceActivityDecision => {
	// Bind to the producer that generated the report. A stale report from a
	// replaced/closed producer must not apply to its successor.
	if (context.currentProducerId === undefined || context.currentProducerId !== report.producerId) {
		return { accept: false };
	}

	// A muted user cannot be speaking. Muting keeps the producer alive (the track
	// is just disabled), so the producer check alone wouldn't catch this.
	if (report.isSpeaking && context.micMuted) {
		return { accept: false };
	}

	// Ordering outlives the authority lease. Otherwise a delayed report could be
	// accepted as fresh after lease expiry. A different producer id is a new
	// session, so its first report establishes a new baseline.
	if (
		currentOrdering !== undefined &&
		currentOrdering.producerId === report.producerId &&
		report.seq <= currentOrdering.lastSeq
	) {
		return { accept: false };
	}

	return {
		accept: true,
		isSpeaking: report.isSpeaking,
		lease: {
			producerId: report.producerId,
			expiresAt: context.now + leaseMs,
		},
		ordering: {
			producerId: report.producerId,
			lastSeq: report.seq,
		},
	};
};

const isClientVoiceActivityLeaseActive = (lease: ClientVoiceActivityLease | undefined, now: number): boolean => {
	return lease !== undefined && lease.expiresAt > now;
};

export type {
	ClientVoiceActivityContext,
	ClientVoiceActivityDecision,
	ClientVoiceActivityLease,
	ClientVoiceActivityOrdering,
	ClientVoiceActivityReport,
};
export { CLIENT_VOICE_ACTIVITY_LEASE_MS, isClientVoiceActivityLeaseActive, resolveClientVoiceActivity };
