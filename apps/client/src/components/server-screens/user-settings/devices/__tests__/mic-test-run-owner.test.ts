import { expect, it } from 'bun:test';
import { createMicTestRunOwner } from '../mic-test-run-owner';

const deferred = () => {
	let resolve = () => {};
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
};
it('does not mask playback for unsupported or rejected acquisition and clears a current failed run', async () => {
	const flags: boolean[] = [];
	const owner = createMicTestRunOwner({ detach: async () => {}, setActive: (active) => flags.push(active) });
	const unsupported = owner.begin();
	await unsupported.ready;
	expect(flags).toEqual([false]);
	const rejected = owner.begin();
	await rejected.ready;
	rejected.activate();
	await rejected.fail();
	expect(flags).toEqual([false, false, true, false]);
});
it('a stop during acquisition prevents stale activation and stale errors or WASM callbacks cannot stop a successor', async () => {
	let active = false;
	const owner = createMicTestRunOwner({
		detach: async () => {},
		setActive: (value) => {
			active = value;
		},
	});
	const first = owner.begin();
	await first.ready;
	await owner.stop();
	first.activate();
	expect(active).toBe(false);
	const second = owner.begin();
	await second.ready;
	second.activate();
	await first.fail();
	expect(active).toBe(true);
	expect(first.isCurrent()).toBe(false);
});
it('detaches before clearing the mask and drains overlapping stops before successor activation', async () => {
	const recording = deferred();
	const context = deferred();
	let active = false;
	const events: string[] = [];
	let calls = 0;
	const owner = createMicTestRunOwner({
		detach: () => {
			calls += 1;
			events.push('detach');
			return calls === 2 ? Promise.all([recording.promise, context.promise]).then(() => {}) : Promise.resolve();
		},
		setActive: (value) => {
			active = value;
			events.push(`active:${value}`);
		},
	});
	const first = owner.begin();
	await first.ready;
	first.activate();
	const stopping = owner.stop();
	const otherStop = owner.stop();
	const successor = owner.begin();
	expect(active).toBe(false);
	let ready = false;
	void successor.ready.then(() => {
		ready = true;
	});
	await Promise.resolve();
	expect(ready).toBe(false);
	recording.resolve();
	await Promise.resolve();
	expect(ready).toBe(false);
	context.resolve();
	await Promise.all([stopping, otherStop, successor.ready]);
	successor.activate();
	expect(active).toBe(true);
	expect(events.slice(0, 2)).toEqual(['detach', 'active:false']);
	expect(first.isCurrent()).toBe(false);
});
