// Ownership token for the shared microphone pipeline refs (raw stream,
// processing pipeline, gain pipeline). Pipeline builds can overlap — a detached
// reconnect attempt's prepareMicPipeline can settle after a successor (or a
// manual device-change restart) has already recycled the refs. Every teardown
// revokes the current claim, so a build that overlapped a teardown detects it
// before installing into (or cleaning up) the shared refs and disposes only its
// own resources instead of clobbering the new owner's.

export class MicPipelineSupersededError extends Error {
	constructor() {
		super('Microphone pipeline superseded by a newer build');
		this.name = 'MicPipelineSupersededError';
	}
}

export type TMicPipelineOwnership = {
	epoch: number;
};

export const createMicPipelineOwnership = (): TMicPipelineOwnership => ({ epoch: 0 });

// Called by every teardown of the shared pipeline refs. Revocation is what
// makes ownership checks meaningful: a claim stays valid exactly until the
// next teardown, which is the only event that hands the refs to someone else.
export const revokeMicPipelineOwnership = (ownership: TMicPipelineOwnership): void => {
	ownership.epoch += 1;
};

// Claims the pipeline for one build and returns its validity predicate. A
// claim establishes its own fresh epoch rather than capturing the current one:
// two builds could otherwise both capture the same epoch and both believe they
// own the refs. At most one predicate is ever valid.
//
// Discipline: claim in the same synchronous tick as STARTING the build's
// teardown, never after awaiting it — claims made after an await let teardown
// completion order decide ownership, so an older build blocked on a slow
// destroy would claim after (and steal ownership from) a newer build. Claimed
// at build start, a later-started build always invalidates every earlier one,
// and the pending teardown remainder is safe because teardown snapshots the
// shared refs synchronously before its first await.
export const claimMicPipelineOwnership = (ownership: TMicPipelineOwnership): (() => boolean) => {
	ownership.epoch += 1;
	const epoch = ownership.epoch;

	return () => ownership.epoch === epoch;
};
