import { describe, expect, it } from 'bun:test';
import {
	claimMicPipelineOwnership,
	createMicPipelineOwnership,
	MicPipelineSupersededError,
	revokeMicPipelineOwnership,
} from '../hooks/mic-pipeline-ownership';

describe('mic pipeline ownership', () => {
	it('holds a claim until the next revocation', () => {
		const ownership = createMicPipelineOwnership();
		const owns = claimMicPipelineOwnership(ownership);

		expect(owns()).toBe(true);

		revokeMicPipelineOwnership(ownership);
		expect(owns()).toBe(false);
	});

	it('hands ownership to the newest build when builds overlap', () => {
		// The detached-attempt race: build A (a stale reconnect attempt) claims,
		// then hangs mid-getUserMedia. Build B (the successor) tears down —
		// revoking A — and claims for itself. When A finally settles it must see
		// itself superseded at every shared-ref checkpoint, while B stays owner.
		const ownership = createMicPipelineOwnership();

		revokeMicPipelineOwnership(ownership); // A's initial cleanup
		const ownsA = claimMicPipelineOwnership(ownership);

		revokeMicPipelineOwnership(ownership); // B's initial cleanup
		const ownsB = claimMicPipelineOwnership(ownership);

		expect(ownsA()).toBe(false);
		expect(ownsB()).toBe(true);
	});

	it('makes the previous claim stale when a new claim lands without an intervening revoke', () => {
		// Two cleanups can interleave (each revokes, awaits destruction, then its
		// build claims): if a claim merely captured the current epoch, both
		// builds could capture the same value and both believe they own the refs.
		// A claim must establish its own epoch so at most one predicate is valid.
		const ownership = createMicPipelineOwnership();

		const first = claimMicPipelineOwnership(ownership);
		const second = claimMicPipelineOwnership(ownership);

		expect(first()).toBe(false);
		expect(second()).toBe(true);
	});

	it('invalidates every prior claim on revocation, not just the latest', () => {
		const ownership = createMicPipelineOwnership();
		const first = claimMicPipelineOwnership(ownership);

		revokeMicPipelineOwnership(ownership);
		const second = claimMicPipelineOwnership(ownership);

		revokeMicPipelineOwnership(ownership);

		expect(first()).toBe(false);
		expect(second()).toBe(false);
	});

	it('exposes a dedicated error type so callers can tell supersession from failure', () => {
		const error = new MicPipelineSupersededError();

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('MicPipelineSupersededError');
	});

	it('keeps a later-started build the owner even when the earlier build cleanup finishes last', async () => {
		// Build order, not cleanup completion order, decides ownership. Build A
		// starts its cleanup and claims in the same tick; the cleanup then blocks
		// on a slow destroy. Build B starts later and does the same. When A's
		// cleanup finally resolves it must not affect the claims — B stays owner.
		const ownership = createMicPipelineOwnership();

		let releaseCleanupA: () => void = () => {};
		const slowCleanupA = new Promise<void>((resolve) => {
			releaseCleanupA = resolve;
		});

		// Build A: cleanup's synchronous prologue revokes, then A claims.
		revokeMicPipelineOwnership(ownership);
		const ownsA = claimMicPipelineOwnership(ownership);

		// Build B starts while A's cleanup is still pending.
		revokeMicPipelineOwnership(ownership);
		const ownsB = claimMicPipelineOwnership(ownership);

		releaseCleanupA();
		await slowCleanupA;

		expect(ownsA()).toBe(false);
		expect(ownsB()).toBe(true);
	});

	it('is claimed by prepareMicPipeline synchronously with starting cleanup, not after awaiting it', async () => {
		// Source-level guard for the ordering the deferred-cleanup test above
		// relies on: a claim placed after `await cleanupMicAudioPipeline()` would
		// let a slow old cleanup claim after — and steal ownership from — a
		// newer build.
		const providerSource = await Bun.file(new URL('../index.tsx', import.meta.url)).text();
		const prepareSource = providerSource.slice(
			providerSource.indexOf('const prepareMicPipeline'),
			providerSource.indexOf('const produceMicTrack'),
		);

		const claimIndex = prepareSource.indexOf('claimMicPipelineOwnership(');
		const cleanupAwaitIndex = prepareSource.indexOf('await cleanupPromise');

		expect(prepareSource).toContain('const cleanupPromise = cleanupMicAudioPipeline();');
		expect(claimIndex).toBeGreaterThan(-1);
		expect(cleanupAwaitIndex).toBeGreaterThan(-1);
		expect(claimIndex).toBeLessThan(cleanupAwaitIndex);
	});
});
