// Pure decision logic for *involuntary* loss of the raw microphone capture —
// a `mute` (source temporarily unable to deliver, e.g. NVIDIA Broadcast / RTX
// Voice taking over the endpoint) or `ended` (device removed) fired by the raw
// device track. Kept DOM-free so every branch is unit-testable in isolation;
// the event handler in the voice provider is a thin adapter that gathers these
// booleans (after a mute settle window) and acts on the result.

type TRawMicLossReason = 'mute' | 'ended';

type TRawMicLossInput = {
	reason: TRawMicLossReason;
	// The capture this track belonged to has been superseded (our own restart
	// stops the old track during cleanup, after clearing the ref).
	superseded: boolean;
	// We are still in a voice channel — otherwise the leave flow owns teardown.
	inChannel: boolean;
	// The user has muted their mic (track.enabled === false), so nothing audible
	// is being captured to recover.
	micMuted: boolean;
	// The raw track is still muted at decision time. Only meaningful for `mute`,
	// where a transient interruption may have already self-healed (unmute) before
	// the settle window elapsed.
	trackStillMuted: boolean;
};

type TRawMicLossAction = 'ignore' | 'recover' | 'teardown-for-unmute';

const resolveRawMicLossAction = (input: TRawMicLossInput): TRawMicLossAction => {
	// A newer capture already replaced this one — let it go.
	if (input.superseded) {
		return 'ignore';
	}

	// A `mute` that self-healed before the settle window elapsed — no real loss.
	if (input.reason === 'mute' && !input.trackStillMuted) {
		return 'ignore';
	}

	// Not in a channel → genuine teardown via the leave flow, not a loss.
	if (!input.inChannel) {
		return 'ignore';
	}

	// Muted: nothing audible to recover, but the captured session is dead. Tear
	// down so the next unmute re-acquires a fresh one rather than unmuting into a
	// silent track.
	if (input.micMuted) {
		return 'teardown-for-unmute';
	}

	return 'recover';
};

export type { TRawMicLossAction, TRawMicLossInput, TRawMicLossReason };
export { resolveRawMicLossAction };
