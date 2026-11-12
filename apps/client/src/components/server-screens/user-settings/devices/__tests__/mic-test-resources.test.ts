import { expect, it } from 'bun:test';
import { createMicTestResources, runMicTestSetup } from '../mic-test-resources';
import { createMicTestRunOwner } from '../mic-test-run-owner';

for (const phase of ['capture', 'pipeline', 'resume'] as const) {
	it(`stops existing resources synchronously during pending ${phase} and serializes a successor`, async () => {
		let resources: ReturnType<typeof createMicTestResources> | undefined;
		const events: string[] = [];
		const owner = createMicTestRunOwner({
			detach: () => resources?.detach() ?? Promise.resolve(),
			setActive: (active) => events.push(`mask:${active}`),
		});
		const run = owner.begin();
		await run.ready;
		run.activate();
		resources = createMicTestResources(run.isCurrent);
		const bundle = resources;
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const setup = run.track(
			runMicTestSetup({
				resources: bundle,
				isCurrent: run.isCurrent,
				capture: () => (phase === 'capture' ? pending.then(() => 'capture') : Promise.resolve('capture')),
				stopCapture: () => {
					events.push('stop');
				},
				pipeline: () => (phase === 'pipeline' ? pending.then(() => 'pipeline') : Promise.resolve('pipeline')),
				destroyPipeline: () => {
					events.push('destroy');
				},
				monitor: () =>
					bundle.own('monitor', () => {
						events.push('disconnect');
					}),
				resume: async () => {
					if (phase === 'resume') await pending;
				},
				onReady: () => {},
			}),
		);
		for (let n = 0; n < 10; n++) await Promise.resolve();
		await owner.stop();
		if (phase !== 'capture') {
			expect(events).toContain('stop');
			expect(events.indexOf('stop')).toBeLessThan(events.indexOf('mask:false'));
		}
		if (phase === 'resume') {
			expect(events).toContain('disconnect');
			expect(events.indexOf('disconnect')).toBeLessThan(events.indexOf('mask:false'));
		}
		const successor = owner.begin();
		let ready = false;
		void successor.ready.then(() => {
			ready = true;
		});
		await Promise.resolve();
		expect(ready).toBe(false);
		release();
		await setup;
		await successor.ready;
		expect(events.filter((event) => event === 'stop')).toHaveLength(1);
		if (phase === 'capture') expect(events).not.toContain('destroy');
	});
}
