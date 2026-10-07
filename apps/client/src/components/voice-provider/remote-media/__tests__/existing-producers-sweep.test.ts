import { describe, expect, it } from 'bun:test';
import type { TRemoteProducerIds } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { createExistingProducersSweeper, type TExistingProducersSweepRequest } from '../existing-producers-sweep';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const createDeferred = () => {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

// A controllable runSweep: records each request and hands back a promise the
// test resolves/rejects on demand, so we can observe coalescing deterministically.
const createRunner = () => {
	const calls: TExistingProducersSweepRequest[] = [];
	const deferreds: ReturnType<typeof createDeferred>[] = [];

	const runSweep = (request: TExistingProducersSweepRequest): Promise<void> => {
		calls.push(request);
		const deferred = createDeferred();
		deferreds.push(deferred);
		return deferred.promise;
	};

	return { calls, deferreds, runSweep };
};

const req = (tag: string, prefetched = false): TExistingProducersSweepRequest => ({
	rtpCapabilities: { tag } as unknown as RtpCapabilities,
	prefetchedProducers: prefetched ? ({} as TRemoteProducerIds) : undefined,
});

const tagsOf = (calls: TExistingProducersSweepRequest[]) =>
	calls.map((call) => (call.rtpCapabilities as unknown as { tag: string }).tag);

describe('existing producers sweeper', () => {
	it('runs a single sweep and clears in-flight so the next call runs fresh', async () => {
		const { calls, deferreds, runSweep } = createRunner();
		const sweeper = createExistingProducersSweeper(runSweep);

		const first = sweeper.schedule(req('a'));
		expect(tagsOf(calls)).toEqual(['a']);

		deferreds[0].resolve();
		await first;

		const second = sweeper.schedule(req('b'));
		expect(tagsOf(calls)).toEqual(['a', 'b']);
		deferreds[1].resolve();
		await second;
	});

	it('joins an active sweep for prefetched requests without running again', async () => {
		const { calls, deferreds, runSweep } = createRunner();
		const sweeper = createExistingProducersSweeper(runSweep);

		const active = sweeper.schedule(req('a'));
		const joined = sweeper.schedule(req('b', true));

		expect(joined).toBe(active);
		expect(tagsOf(calls)).toEqual(['a']);

		deferreds[0].resolve();
		await active;
		expect(tagsOf(calls)).toEqual(['a']);
	});

	it('queues a non-prefetched request and drains it after the active sweep', async () => {
		const { calls, deferreds, runSweep } = createRunner();
		const sweeper = createExistingProducersSweeper(runSweep);

		const active = sweeper.schedule(req('a'));
		sweeper.schedule(req('b'));
		expect(tagsOf(calls)).toEqual(['a']);

		deferreds[0].resolve();
		await flush();
		expect(tagsOf(calls)).toEqual(['a', 'b']);

		deferreds[1].resolve();
		await active;
	});

	it('coalesces multiple queued non-prefetched requests to the latest', async () => {
		const { calls, deferreds, runSweep } = createRunner();
		const sweeper = createExistingProducersSweeper(runSweep);

		const active = sweeper.schedule(req('a'));
		sweeper.schedule(req('b'));
		sweeper.schedule(req('c'));
		expect(tagsOf(calls)).toEqual(['a']);

		deferreds[0].resolve();
		await flush();
		expect(tagsOf(calls)).toEqual(['a', 'c']);

		deferreds[1].resolve();
		await active;
	});

	it('settles and clears in-flight when a sweep throws', async () => {
		const { calls, deferreds, runSweep } = createRunner();
		const sweeper = createExistingProducersSweeper(runSweep);

		const failing = sweeper.schedule(req('a'));
		deferreds[0].reject(new Error('boom'));
		await expect(failing).rejects.toThrow('boom');

		const next = sweeper.schedule(req('b'));
		expect(tagsOf(calls)).toEqual(['a', 'b']);
		deferreds[1].resolve();
		await next;
	});

	// The regression guard: a stalled sweep (e.g. a hung getProducers during
	// reconnect) must not poison the sweeper. reset() — called by transport
	// cleanup — frees the slot so the next generation runs fresh, and the stalled
	// sweep, once it finally settles, cannot clobber the new generation.
	it('reset releases a stalled sweep so the next generation runs fresh', async () => {
		const { calls, deferreds, runSweep } = createRunner();
		const sweeper = createExistingProducersSweeper(runSweep);

		// Stalled sweep, never resolved.
		sweeper.schedule(req('stalled'));
		// Without reset these would coalesce onto the stalled sweep forever.
		sweeper.schedule(req('joined', true));
		sweeper.schedule(req('queued'));
		expect(tagsOf(calls)).toEqual(['stalled']);

		sweeper.reset();

		const fresh = sweeper.schedule(req('fresh'));
		expect(tagsOf(calls)).toEqual(['stalled', 'fresh']);

		// The stalled sweep finally settles — it must not run the abandoned queue
		// nor clobber the fresh generation's in-flight slot.
		deferreds[0].resolve();
		await flush();
		expect(tagsOf(calls)).toEqual(['stalled', 'fresh']);

		// fresh generation still coalesces and drains normally.
		sweeper.schedule(req('after'));
		deferreds[1].resolve();
		await flush();
		expect(tagsOf(calls)).toEqual(['stalled', 'fresh', 'after']);
		deferreds[2].resolve();
		await fresh;
	});
});
