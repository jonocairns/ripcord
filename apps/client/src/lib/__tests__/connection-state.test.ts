import { describe, expect, test } from 'bun:test';
import {
	createConnectionStore,
	reduceConnection,
	type TConnectionCommand,
	type TConnectionEvent,
	type TConnectionState,
} from '../connection-state';

const reason = new Error('cleanup');
const phases: TConnectionState['phase'][] = [
	{ name: 'idle' },
	{ name: 'connecting' },
	{ name: 'ready' },
	{ name: 'recovering', since: 10 },
];
const events: TConnectionEvent[] = [
	{ type: 'client-started' },
	{ type: 'cleaned-up', reason },
	...[false, true].flatMap((online) =>
		[false, true].map(
			(socketOpen): TConnectionEvent => ({
				type: 'socket-opened',
				online,
				socketOpen,
				now: 20,
			}),
		),
	),
	{ type: 'online', socketOpen: false },
	{ type: 'online', socketOpen: true },
	{ type: 'socket-closed', terminal: false, now: 20 },
	{ type: 'socket-closed', terminal: true, now: 20 },
	{ type: 'socket-observed-closed', now: 20 },
	{ type: 'grace-expired', online: false },
	{ type: 'grace-expired', online: true },
	{ type: 'join-completed' },
	{ type: 'rejoin-disarmed' },
	{ type: 'session-authenticated' },
];
const base = (phase: TConnectionState['phase'], resumePending: boolean, rejoinArmed: boolean): TConnectionState => ({
	phase,
	resumePending,
	rejoinArmed,
	clientEpoch: 4,
	socketEpoch: 7,
});

describe('connection transition table', () => {
	for (const phase of phases)
		for (const pending of [false, true])
			for (const armed of [false, true]) {
				for (const event of events) {
					test(`${phase.name}, pending=${pending}, armed=${armed}: ${JSON.stringify(event)}`, () => {
						const previous = base(phase, pending, armed);
						const expected = { ...previous };
						const commands: TConnectionCommand['type'][] = [];
						const recovering: TConnectionState['phase'] =
							phase.name === 'ready' ? { name: 'recovering', since: 20 } : phase;
						switch (event.type) {
							case 'client-started':
								expected.clientEpoch++;
								expected.phase = phase.name === 'recovering' ? phase : { name: 'connecting' };
								expected.resumePending = false;
								expected.rejoinArmed = false;
								commands.push(
									'clear-online-listener',
									'clear-grace-timer',
									'retire-client',
									'pause-telemetry',
									'invalidate-session',
								);
								break;
							case 'cleaned-up':
								expected.clientEpoch++;
								expected.phase = { name: 'idle' };
								expected.resumePending = false;
								expected.rejoinArmed = false;
								commands.push(
									'clear-telemetry',
									'cancel-session',
									'clear-online-listener',
									'clear-grace-timer',
									'retire-client',
								);
								break;
							case 'socket-opened':
								expected.socketEpoch++;
								expected.phase = recovering;
								commands.push('pause-telemetry', 'invalidate-session');
								if (pending && !event.online) commands.push('await-online');
								if (pending && event.online) {
									commands.push('clear-online-listener');
									if (event.socketOpen) {
										expected.resumePending = false;
										commands.push('clear-grace-timer');
										if (armed) commands.push('run-rejoin');
									}
								}
								break;
							case 'online':
								commands.push('clear-online-listener');
								if (pending && event.socketOpen) {
									expected.resumePending = false;
									commands.push('clear-grace-timer');
									if (armed) commands.push('run-rejoin');
								}
								break;
							case 'socket-closed':
								expected.phase = event.terminal ? { name: 'idle' } : recovering;
								commands.push('invalidate-session', 'pause-telemetry', 'clear-online-listener');
								if (!event.terminal) {
									expected.resumePending = true;
									commands.push('voice-socket-dropped', 'arm-grace-timer');
								}
								break;
							case 'socket-observed-closed':
								expected.phase = recovering;
								commands.push('invalidate-session');
								break;
							case 'grace-expired':
								if (pending) {
									commands.push(event.online ? 'teardown-to-disconnect-screen' : 'arm-grace-timer');
									if (event.online) expected.resumePending = false;
								}
								break;
							case 'join-completed':
								if (phase.name !== 'idle') expected.rejoinArmed = true;
								break;
							case 'rejoin-disarmed':
								expected.rejoinArmed = false;
								break;
							case 'session-authenticated':
								if (phase.name !== 'idle') {
									expected.phase = { name: 'ready' };
									commands.push('authenticate-session', 'voice-session-authenticated', 'authenticate-telemetry');
								}
								break;
						}
						const result = reduceConnection(previous, event);
						expect(result.state).toEqual(expected);
						expect(result.commands).toEqual(
							commands.map((type) => (type === 'cancel-session' ? { type, reason } : { type })),
						);
						expect(previous).toEqual(base(phase, pending, armed));
						for (const last of ['run-rejoin', 'teardown-to-disconnect-screen'] satisfies TConnectionCommand['type'][]) {
							const index = commands.indexOf(last);
							if (index >= 0) expect(index).toBe(commands.length - 1);
						}
					});
				}
			}
});

test('gate authentication agrees with phase after every prefix of all sequences up to three events', () => {
	const visit = (state: TConnectionState, authenticated: boolean, depth: number) => {
		if (!depth) return;
		for (const event of events) {
			const result = reduceConnection(state, event);
			let gate = authenticated;
			for (const command of result.commands) {
				if (command.type === 'authenticate-session') gate = true;
				if (command.type === 'invalidate-session' || command.type === 'cancel-session') gate = false;
			}
			expect(gate).toBe(result.state.phase.name === 'ready');
			visit(result.state, gate, depth - 1);
		}
	};
	visit(createConnectionStore().getState(), false, 3);
});

test('recovery keeps its original monotonic start through closes and client replacement', () => {
	const store = createConnectionStore();
	store.dispatch({ type: 'client-started' });
	store.dispatch({ type: 'session-authenticated' });
	store.dispatch({ type: 'socket-closed', terminal: false, now: 10 });
	store.dispatch({ type: 'socket-closed', terminal: false, now: 20 });
	store.dispatch({ type: 'client-started' });
	expect(store.getState().phase).toEqual({ name: 'recovering', since: 10 });
	expect(store.getState().rejoinArmed).toBe(false);
	store.dispatch({ type: 'session-authenticated' });
	store.dispatch({ type: 'socket-closed', terminal: false, now: 30 });
	expect(store.getState().phase).toEqual({ name: 'recovering', since: 30 });
});

test('store snapshots stay stable on no-ops and listeners receive committed state and previous state', () => {
	const store = createConnectionStore();
	const initial = store.getState();
	const calls: { state: TConnectionState; previous: TConnectionState }[] = [];
	const unsubscribe = store.subscribe((state, previous) => {
		expect(store.getState()).toBe(state);
		calls.push({ state, previous });
	});
	store.dispatch({ type: 'join-completed' });
	expect(store.getState()).toBe(initial);
	expect(calls).toEqual([]);
	store.dispatch({ type: 'client-started' });
	expect(calls).toEqual([{ state: store.getState(), previous: initial }]);
	unsubscribe();
	store.dispatch({ type: 'cleaned-up', reason });
	expect(calls.length).toBe(1);
});
