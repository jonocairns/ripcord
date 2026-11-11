// Allow transient outages to recover silently. The 45 s deadline is nominally
// 15 s before the 60 s voice intent TTL and server grace, but those clocks start
// at different moments: that margin is not guaranteed.
const RECOVERY_DEADLINE_MS = 45_000;
const UNAUTHENTICATED_GRACE_MS = 20_000;
const OFFLINE_RECHECK_MS = 20_000;

type TConnectionPhase =
	| { name: 'idle' }
	| { name: 'connecting' }
	| { name: 'ready' }
	| { name: 'recovering'; since: number };

type TConnectionState = {
	phase: TConnectionPhase;
	clientEpoch: number;
	socketEpoch: number;
	resumePending: boolean;
	rejoinArmed: boolean;
};

type TConnectionEvent =
	| { type: 'client-started' }
	| { type: 'cleaned-up'; reason: unknown }
	| { type: 'socket-opened'; online: boolean; socketOpen: boolean; now: number }
	| { type: 'online'; socketOpen: boolean; now: number }
	| { type: 'socket-closed'; terminal: boolean; now: number }
	| { type: 'socket-observed-closed'; now: number }
	| { type: 'grace-expired'; online: boolean }
	| { type: 'join-completed'; passwordChangeRequired: boolean }
	| { type: 'rejoin-disarmed' | 'session-authenticated' };

type TConnectionCommand =
	| { type: 'cancel-session'; reason: unknown }
	| { type: 'arm-grace-timer'; delayMs: number }
	| {
			type:
				| 'clear-online-listener'
				| 'clear-grace-timer'
				| 'retire-client'
				| 'pause-telemetry'
				| 'invalidate-session'
				| 'clear-telemetry'
				| 'await-online'
				| 'run-rejoin'
				| 'voice-socket-dropped'
				| 'teardown-to-disconnect-screen'
				| 'authenticate-session'
				| 'voice-session-authenticated'
				| 'authenticate-telemetry';
	  };

const initialState = (): TConnectionState => ({
	phase: { name: 'idle' },
	clientEpoch: 0,
	socketEpoch: 0,
	resumePending: false,
	rejoinArmed: false,
});

const reduceConnection = (
	previous: TConnectionState,
	event: TConnectionEvent,
): {
	state: TConnectionState;
	commands: TConnectionCommand[];
} => {
	let state = previous;
	const commands: TConnectionCommand[] = [];
	const emit = (...types: Exclude<TConnectionCommand['type'], 'cancel-session' | 'arm-grace-timer'>[]) => {
		for (const type of types) commands.push({ type });
	};
	const recover = (now: number) =>
		previous.phase.name === 'ready' ? ({ name: 'recovering', since: now } satisfies TConnectionPhase) : previous.phase;
	const resume = (socketOpen: boolean) => {
		emit('clear-online-listener');
		if (previous.resumePending && socketOpen) {
			state = { ...state, resumePending: false };
			if (state.phase.name !== 'recovering') emit('clear-grace-timer');
			if (previous.rejoinArmed) emit('run-rejoin');
		}
	};
	switch (event.type) {
		case 'client-started':
			state = {
				...previous,
				clientEpoch: previous.clientEpoch + 1,
				phase: previous.phase.name === 'recovering' ? previous.phase : { name: 'connecting' },
				resumePending: false,
				rejoinArmed: false,
			};
			if (previous.phase.name !== 'recovering') emit('clear-online-listener', 'clear-grace-timer');
			emit('retire-client', 'pause-telemetry', 'invalidate-session');
			break;
		case 'cleaned-up':
			state = {
				...previous,
				clientEpoch: previous.clientEpoch + 1,
				phase: { name: 'idle' },
				resumePending: false,
				rejoinArmed: false,
			};
			emit('clear-telemetry');
			commands.push({ type: 'cancel-session', reason: event.reason });
			emit('clear-online-listener', 'clear-grace-timer', 'retire-client');
			break;
		case 'socket-opened':
			state = { ...previous, socketEpoch: previous.socketEpoch + 1, phase: recover(event.now) };
			emit('pause-telemetry', 'invalidate-session');
			if (previous.resumePending) {
				if (!event.online) emit('await-online');
				else resume(event.socketOpen);
			}
			break;
		case 'online':
			if (previous.phase.name === 'recovering' && event.now >= previous.phase.since + RECOVERY_DEADLINE_MS) {
				state = { ...previous, resumePending: false };
				emit('clear-online-listener', 'teardown-to-disconnect-screen');
			} else resume(event.socketOpen);
			break;
		case 'socket-closed':
			state = {
				...previous,
				phase: event.terminal ? { name: 'idle' } : recover(event.now),
				resumePending: event.terminal ? previous.resumePending : true,
			};
			emit('invalidate-session', 'pause-telemetry', 'clear-online-listener');
			if (!event.terminal) {
				emit('voice-socket-dropped');
				commands.push({
					type: 'arm-grace-timer',
					delayMs:
						state.phase.name === 'recovering'
							? Math.max(0, state.phase.since + RECOVERY_DEADLINE_MS - event.now)
							: UNAUTHENTICATED_GRACE_MS,
				});
			}
			break;
		case 'socket-observed-closed':
			state = { ...previous, phase: recover(event.now) };
			emit('invalidate-session');
			break;
		case 'grace-expired':
			if (previous.phase.name === 'idle' || previous.phase.name === 'ready') break;
			if (previous.phase.name !== 'recovering' && !previous.resumePending) break;
			// Stay paused while offline: the disconnect screen cannot help while the
			// network is unavailable. Preserve deferred recovery and the pending resume
			// signal so the next online open re-authenticates.
			if (!event.online) {
				commands.push({ type: 'arm-grace-timer', delayMs: OFFLINE_RECHECK_MS });
				if (previous.phase.name === 'recovering') emit('await-online');
			} else {
				state = { ...previous, resumePending: false };
				emit('teardown-to-disconnect-screen');
			}
			break;
		case 'join-completed':
			if (previous.phase.name !== 'idle') {
				state = { ...previous, rejoinArmed: true };
				if (previous.phase.name === 'recovering' && event.passwordChangeRequired) {
					state = { ...state, phase: { name: 'connecting' } };
					emit('clear-grace-timer');
				}
			}
			break;
		case 'rejoin-disarmed':
			state = { ...previous, rejoinArmed: false };
			break;
		case 'session-authenticated':
			if (previous.phase.name !== 'idle') {
				state = { ...previous, phase: { name: 'ready' } };
				emit('clear-grace-timer', 'authenticate-session', 'voice-session-authenticated', 'authenticate-telemetry');
			}
			break;
	}
	if (
		state.phase.name === previous.phase.name &&
		(state.phase.name !== 'recovering' ||
			previous.phase.name !== 'recovering' ||
			state.phase.since === previous.phase.since) &&
		state.clientEpoch === previous.clientEpoch &&
		state.socketEpoch === previous.socketEpoch &&
		state.resumePending === previous.resumePending &&
		state.rejoinArmed === previous.rejoinArmed
	)
		state = previous;
	return { state, commands };
};

const createConnectionStore = () => {
	let state = initialState();
	// Listeners must not dispatch. Commands run only after dispatch returns.
	const listeners = new Set<(state: TConnectionState, previous: TConnectionState) => void>();
	return {
		getState: () => state,
		subscribe: (listener: (state: TConnectionState, previous: TConnectionState) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		dispatch: (event: TConnectionEvent) => {
			const previous = state;
			const result = reduceConnection(previous, event);
			state = result.state;
			if (state !== previous) for (const listener of listeners) listener(state, previous);
			return result.commands;
		},
	};
};

export {
	createConnectionStore,
	OFFLINE_RECHECK_MS,
	RECOVERY_DEADLINE_MS,
	reduceConnection,
	type TConnectionCommand,
	type TConnectionEvent,
	type TConnectionState,
	UNAUTHENTICATED_GRACE_MS,
};
