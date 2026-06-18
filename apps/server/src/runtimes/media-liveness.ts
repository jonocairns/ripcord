// Media-liveness watchdog policy (pure decision logic).
//
// A WebRTC media path can die without the client's transport ever transitioning
// to ICE/DTLS `failed` — the only failure signal the client acts on — e.g. a
// half-open UDP drop where ICE consent lingers. The user then sits in the voice
// channel hearing nothing, with nothing to correct it.
//
// The server has a definitive view: a client that is actively *receiving* media
// sends periodic RTCP receiver reports on its recv transport, so the server's
// transport-level `bytesReceived` keeps advancing even during Opus DTX silence
// (RTCP is not gated by DTX) and flatlines only when the path is genuinely dead.
// The runtime samples that counter — scoped to users with an active consumer, so
// the guaranteed RTCP signal is always present — and feeds it here; when it stops
// advancing for the timeout window we signal failure, which clients already turn
// into a transport-recovery cycle (VOICE_TRANSPORT_FAILED).
//
// The timeout sits *above* the client's own ICE grace (ICE_DISCONNECT_GRACE_MS,
// 30s) so a client-side ICE restart always gets first crack; the server only
// fires when the client genuinely cannot self-recover (e.g. ICE never even
// transitioned to `disconnected`, so the client never started recovering).

const MEDIA_LIVENESS_CHECK_INTERVAL_MS = 5_000;
const MEDIA_LIVENESS_TIMEOUT_MS = 45_000;
// Additive per-user spread on the timeout so a server-wide media failure (e.g.
// the SFU's UDP path dies for everyone at once) does not fire VOICE_TRANSPORT_
// FAILED for every consumer on the same tick — that would stampede the server
// with simultaneous restoreOrJoin recoveries. Additive (never subtractive) so
// the effective window stays at or above the base, preserving the "fires after
// the client ICE grace" guarantee. Each user's spread is captured once per
// transport generation so the deadline does not jitter tick to tick.
const MEDIA_LIVENESS_JITTER_MS = 15_000;

type TMediaLivenessSample = {
	// Identity of the transports this sample was taken against. When the client
	// recovers it creates fresh transports (new ids), so a changed key means
	// "rebaseline" rather than "compare across a discontinuity".
	transportKey: string;
	bytesReceived: number;
	now: number;
};

type TMediaLivenessState = {
	transportKey: string;
	lastBytesReceived: number;
	lastProgressAt: number;
	// The effective timeout for this transport generation, captured at baseline
	// (base + jitter) so the deadline is stable across ticks.
	timeoutMs: number;
	// Set once failure has been signalled for this transport generation so we do
	// not re-signal every tick while recovery is in flight.
	failed: boolean;
};

type TMediaLivenessDecision = {
	next: TMediaLivenessState;
	shouldSignalFailure: boolean;
};

const baseline = (sample: TMediaLivenessSample, timeoutMs: number): TMediaLivenessState => ({
	transportKey: sample.transportKey,
	lastBytesReceived: sample.bytesReceived,
	lastProgressAt: sample.now,
	timeoutMs,
	failed: false,
});

const evaluateMediaLiveness = (
	previous: TMediaLivenessState | undefined,
	sample: TMediaLivenessSample,
	// Effective timeout to apply when (re)baselining. Ignored on a continuation,
	// where the timeout captured at baseline is kept so the deadline is stable.
	baselineTimeoutMs: number,
): TMediaLivenessDecision => {
	// First sample, or the transports were recreated by a recovery cycle:
	// (re)baseline instead of comparing across transport identities.
	if (!previous || previous.transportKey !== sample.transportKey) {
		return { next: baseline(sample, baselineTimeoutMs), shouldSignalFailure: false };
	}

	// The path is moving bytes — it is alive. Advance the baseline and clear any
	// prior failure latch (a recovered same-generation transport).
	if (sample.bytesReceived > previous.lastBytesReceived) {
		return {
			next: {
				...previous,
				lastBytesReceived: sample.bytesReceived,
				lastProgressAt: sample.now,
				failed: false,
			},
			shouldSignalFailure: false,
		};
	}

	const timedOut = sample.now - previous.lastProgressAt >= previous.timeoutMs;

	return {
		next: { ...previous, failed: previous.failed || timedOut },
		// Signal only on the transition into the timed-out state, once per
		// transport generation.
		shouldSignalFailure: timedOut && !previous.failed,
	};
};

export {
	evaluateMediaLiveness,
	MEDIA_LIVENESS_CHECK_INTERVAL_MS,
	MEDIA_LIVENESS_JITTER_MS,
	MEDIA_LIVENESS_TIMEOUT_MS,
	type TMediaLivenessDecision,
	type TMediaLivenessSample,
	type TMediaLivenessState,
};
