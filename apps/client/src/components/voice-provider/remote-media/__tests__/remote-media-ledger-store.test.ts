import { expect, mock, test } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import { createRemoteMediaLedgerStore } from '../remote-media-ledger-store';
import {
	isRemoteConsumeStartCurrent,
	markRemoteProducerPresent,
	markRemoteWatchRequested,
	type TRemoteMediaCommand,
} from '../remote-media-subscriptions';
import { getPendingStreamKey } from '../use-pending-streams';
import { consumeStartCases, subscriptionsFor } from './remote-media-consume-current-fixture';

const commands: TRemoteMediaCommand[] = [1, 2, 3].map((remoteId) => ({
	type: 'closeConsumer',
	key: getPendingStreamKey(remoteId, StreamKind.VIDEO),
	remoteId,
	kind: StreamKind.VIDEO,
}));
const fixture = () => {
	const transition = mock(() => {});
	const error = mock((_error: unknown, _command: TRemoteMediaCommand) => {});
	const store = createRemoteMediaLedgerStore({ now: () => 1, onTransition: transition, onCommandError: error });
	const listener = mock(() => {});
	store.subscribe(listener);
	const enqueue = (batch = commands) => store.dispatch((state) => ({ state, commands: batch }));
	return { store, transition, error, listener, enqueue };
};
test('synchronous snapshots, ordered observation, no-op identity and cached projections', () => {
	const order: string[] = [];
	const store = createRemoteMediaLedgerStore({
		now: () => 1,
		onTransition: (prev, next) => {
			expect(prev.size).toBe(0);
			expect(store.getSnapshot()).toBe(next);
			order.push('transition');
		},
	});
	store.subscribe(() => order.push('listener'));
	store.setCommandRunner(() => order.push('command'));
	store.dispatch((prev, now) => markRemoteProducerPresent(prev, 7, StreamKind.AUDIO, now, 'mic'));
	expect(store.getSnapshot().size).toBe(1);
	expect(order).toEqual(['transition', 'listener', 'command']);
	const snapshot = store.getSnapshot();
	const pending = store.getPendingStreams();
	const visible = store.getVisibleRemoteMedia();
	store.dispatch((state) => ({ state: new Map(state), commands: [] }));
	expect(store.getSnapshot()).toBe(snapshot);
	expect(store.getPendingStreams()).toBe(pending);
	expect(store.getVisibleRemoteMedia()).toBe(visible);
	expect(order).toHaveLength(3);
});
test('command-only results wait for registration, then drain inside dispatch without notifying', () => {
	const f = fixture();
	const before = f.store.getSnapshot();
	const seen: number[] = [];
	f.enqueue();
	expect(seen).toEqual([]);
	f.store.setCommandRunner((command) => seen.push(command.remoteId));
	expect(seen).toEqual([1, 2, 3]);
	f.enqueue([commands[0]].filter((c) => c !== undefined));
	expect(seen).toEqual([1, 2, 3, 1]);
	expect(f.store.getSnapshot()).toBe(before);
	expect(f.listener).not.toHaveBeenCalled();
	expect(f.transition).not.toHaveBeenCalled();
});
test('reentrant dispatch commits immediately and drains appended commands once', () => {
	const f = fixture();
	const seen: number[] = [];
	f.store.setCommandRunner((command) => {
		seen.push(command.remoteId);
		if (command.remoteId === 1) {
			f.store.dispatch((prev, now) => markRemoteProducerPresent(prev, 7, StreamKind.VIDEO, now, 'p'));
			expect(f.store.getSnapshot().size).toBe(1);
			f.enqueue(commands.slice(2));
			expect(seen).toEqual([1]);
		}
	});
	f.enqueue(commands.slice(0, 2));
	expect(seen).toEqual([1, 2, 3]);
	expect(f.transition).toHaveBeenCalledTimes(1);
});
test('unregister mid-drain holds remaining work; StrictMode registration never replays claimed commands', () => {
	const f = fixture();
	const seen: number[] = [];
	const runner = (command: TRemoteMediaCommand) => {
		seen.push(command.remoteId);
		f.store.setCommandRunner(undefined);
	};
	f.enqueue();
	f.store.setCommandRunner(runner);
	expect(seen).toEqual([1]);
	f.store.setCommandRunner((command) => seen.push(command.remoteId));
	f.store.setCommandRunner(undefined);
	f.store.setCommandRunner((command) => seen.push(command.remoteId));
	expect(seen).toEqual([1, 2, 3]);
});
for (const preserveIntent of [false, true])
	test(`clear during drain drops queued work (preserve=${preserveIntent})`, () => {
		const f = fixture();
		f.store.dispatch((prev, now) => markRemoteProducerPresent(prev, 7, StreamKind.VIDEO, now, 'p'));
		f.store.dispatch((prev, now) => markRemoteWatchRequested(prev, 7, StreamKind.VIDEO, now));
		// Clear the queued watch command before constructing the controlled batch.
		f.store.clear({ preserveIntent: true });
		const seen: number[] = [];
		f.store.setCommandRunner((command) => {
			seen.push(command.remoteId);
			f.store.clear({ preserveIntent });
		});
		f.enqueue();
		expect(seen).toEqual([1]);
		expect([...f.store.getSnapshot().values()].some((slot) => slot.desired)).toBe(preserveIntent);
		f.enqueue(commands.slice(2));
		expect(seen).toEqual([1, 3]);
	});
test('throwing command is reported, remaining and later work drain', () => {
	const f = fixture();
	const seen: number[] = [];
	const failure = new Error('runner');
	f.store.setCommandRunner((command) => {
		if (command.remoteId === 1) throw failure;
		seen.push(command.remoteId);
	});
	f.enqueue();
	f.enqueue(commands.slice(2));
	expect(seen).toEqual([2, 3, 3]);
	expect(f.error).toHaveBeenCalledWith(failure, commands[0]);
});
for (const row of consumeStartCases)
	test(`store consume currency: ${row.name}`, () => {
		const f = fixture();
		f.store.dispatch(() => ({ state: subscriptionsFor(row.slot), commands: [] }));
		expect(
			isRemoteConsumeStartCurrent(
				f.store.getSnapshot(),
				{ remoteId: 7, kind: StreamKind.VIDEO, expectedProducerId: row.expected },
				1,
			),
		).toBe(row.current);
	});

test('a throwing transition observer cannot strand committed commands', () => {
	const failure = new Error('observer failed');
	const store = createRemoteMediaLedgerStore({
		now: () => 1,
		onTransition: () => {
			throw failure;
		},
	});
	const delivered: TRemoteMediaCommand[] = [];
	store.setCommandRunner((command) => delivered.push(command));
	expect(() => store.dispatch(() => ({ state: subscriptionsFor({}), commands }))).toThrow(failure);
	expect(store.getSnapshot().size).toBe(1);
	expect(delivered).toEqual(commands);
	store.dispatch((state) => ({ state, commands: [commands[0]].filter((command) => command !== undefined) }));
	expect(delivered).toHaveLength(4);
});
