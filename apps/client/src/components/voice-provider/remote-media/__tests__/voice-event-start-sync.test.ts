import { expect, test } from 'bun:test';
import { createProducerSyncAfterSubscriptionStart, PRODUCER_SYNC_ACK_FALLBACK_MS } from '../voice-event-start-sync';

const setup = () => {
	const reasons: string[] = [];
	const timers: { callback: () => void; delay: number; cancelled: boolean }[] = [];
	let current = true;
	const gate = createProducerSyncAfterSubscriptionStart({
		sync: (reason) => reasons.push(reason),
		isCurrentClient: () => current,
		fallbackMs: PRODUCER_SYNC_ACK_FALLBACK_MS,
		schedule: (callback, delay) => {
			const timer = { callback, delay, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	});
	const fire = () => {
		for (const timer of timers) timer.callback();
	};
	return {
		gate,
		reasons,
		timers,
		fire,
		retire: () => {
			current = false;
		},
		restore: () => {
			current = true;
		},
	};
};
for (const first of ['newProducer', 'producerClosed'] as const) {
	test(`requires both starts, ${first} first, and runs only once`, () => {
		const { gate, reasons, timers, fire } = setup();
		gate.markStarted(first);
		gate.markStarted(first);
		expect(reasons).toEqual([]);
		gate.markStarted(first === 'newProducer' ? 'producerClosed' : 'newProducer');
		gate.markConnectionChanged();
		gate.markStarted('newProducer');
		gate.markStarted('producerClosed');
		fire();
		expect(reasons).toEqual(['acknowledged']);
		expect(timers).toHaveLength(1);
		expect(timers[0]?.delay).toBe(20_000);
		expect(timers[0]?.cancelled).toBe(true);
	});
}
for (const boundaries of [1, 2]) {
	test(`discards starts across ${boundaries} connection notifications`, () => {
		const { gate, reasons } = setup();
		gate.markStarted('newProducer');
		for (let i = 0; i < boundaries; i++) gate.markConnectionChanged();
		gate.markStarted('producerClosed');
		expect(reasons).toEqual([]);
		gate.markStarted('newProducer');
		expect(reasons).toEqual(['acknowledged']);
	});
}
test('discards a late old-socket acknowledgement on the new socket opening', () => {
	const { gate, reasons } = setup();
	gate.markStarted('newProducer');
	gate.markConnectionChanged();
	gate.markStarted('producerClosed');
	gate.markConnectionChanged();
	gate.markStarted('newProducer');
	expect(reasons).toEqual([]);
	gate.markStarted('producerClosed');
	expect(reasons).toEqual(['acknowledged']);
});
for (const firstStarted of [false, true]) {
	test(`an ended subscription kills the gate (first started: ${firstStarted})`, () => {
		const { gate, reasons, timers, fire } = setup();
		if (firstStarted) gate.markStarted('newProducer');
		gate.markEnded();
		gate.markStarted('newProducer');
		gate.markStarted('producerClosed');
		fire();
		expect(reasons).toEqual([]);
		expect(timers[0]?.cancelled).toBe(true);
	});
}
test('cleanup cancels the fallback and ignores queued callbacks', () => {
	const { gate, reasons, timers, fire } = setup();
	gate.dispose();
	gate.markStarted('newProducer');
	gate.markStarted('producerClosed');
	gate.markConnectionChanged();
	gate.markEnded();
	fire();
	expect(reasons).toEqual([]);
	expect(timers[0]?.cancelled).toBe(true);
});
for (const viaFallback of [false, true]) {
	test(`client retirement permanently kills the gate (fallback: ${viaFallback})`, () => {
		const { gate, reasons, timers, fire, retire, restore } = setup();
		retire();
		if (viaFallback) fire();
		else gate.markStarted('newProducer');
		restore();
		gate.markStarted('newProducer');
		gate.markStarted('producerClosed');
		fire();
		expect(reasons).toEqual([]);
		expect(timers[0]?.cancelled).toBe(true);
	});
}
for (const firstStarted of [false, true]) {
	test(`fallback runs once and permits late ordered sync (first started: ${firstStarted})`, () => {
		const { gate, reasons, fire } = setup();
		if (firstStarted) gate.markStarted('newProducer');
		fire();
		fire();
		expect(reasons).toEqual(['fallback']);
		gate.markStarted('newProducer');
		gate.markStarted('producerClosed');
		fire();
		expect(reasons).toEqual(['fallback', 'acknowledged']);
	});
}
test('the post-attach snapshot recovers the producer lost before listener attachment', () => {
	const producers = new Set<string>();
	const listeners: ((id: string) => void)[] = [];
	const delivered: string[] = [];
	const discovered = new Set<string>();
	const server = {
		snapshot: () => [...producers],
		attach: () =>
			listeners.push((id) => {
				delivered.push(id);
				discovered.add(id);
			}),
		publish: (id: string) => {
			producers.add(id);
			for (const listener of listeners) listener(id);
		},
	};
	const gate = createProducerSyncAfterSubscriptionStart({
		sync: () => {
			for (const id of server.snapshot()) discovered.add(id);
		},
		isCurrentClient: () => true,
		fallbackMs: 20_000,
		schedule: () => () => {},
	});
	expect(server.snapshot()).toEqual([]);
	server.publish('p1');
	server.attach();
	gate.markStarted('newProducer');
	server.publish('p2');
	expect(discovered.has('p1')).toBe(false);
	gate.markStarted('producerClosed');
	server.publish('p3');
	expect(delivered).toEqual(['p2', 'p3']);
	expect([...discovered].sort()).toEqual(['p1', 'p2', 'p3']);
});
