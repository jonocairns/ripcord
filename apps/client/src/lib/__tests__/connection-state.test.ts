import { describe, expect, test } from 'bun:test';
import {
	createConnectionStore,
	reduceConnection,
	type TConnectionCommand,
	type TConnectionEvent,
	type TConnectionState,
} from '../connection-state';

const reason = new Error('cleanup');
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
	{ type: 'online', now: 30000, socketOpen: false },
	{ type: 'online', now: 30000, socketOpen: true },
	{ type: 'online', now: 100000, socketOpen: false },
	{ type: 'online', now: 100000, socketOpen: true },
	{ type: 'socket-closed', terminal: false, now: 20 },
	{ type: 'socket-closed', terminal: true, now: 20 },
	{ type: 'socket-observed-closed', now: 20 },
	{ type: 'grace-expired', online: false },
	{ type: 'grace-expired', online: true },
	{ type: 'join-completed', passwordChangeRequired: false },
	{ type: 'join-completed', passwordChangeRequired: true },
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

type TRow = {
	name: string;
	previous: TConnectionState;
	event: TConnectionEvent;
	expected: TConnectionState;
	commands: TConnectionCommand[];
};
const rows: TRow[] = [
	{
		name: 'ready socket open with resume pending preserves the recovery timer',
		previous: base({ name: 'ready' }, true, true),
		event: { type: 'socket-opened', now: 1000, online: true, socketOpen: true },
		expected: { ...base({ name: 'recovering', since: 1000 }, false, true), socketEpoch: 8 },
		commands: [
			{ type: 'pause-telemetry' },
			{ type: 'invalidate-session' },
			{ type: 'clear-online-listener' },
			{ type: 'run-rejoin' },
		],
	},
	{
		name: 'ready online with resume pending never tears down, even after the deadline',
		previous: base({ name: 'ready' }, true, true),
		event: { type: 'online', now: 100000, socketOpen: true },
		expected: base({ name: 'ready' }, false, true),
		commands: [{ type: 'clear-online-listener' }, { type: 'clear-grace-timer' }, { type: 'run-rejoin' }],
	},
	{
		name: "start { name: 'idle' }",
		previous: base({ name: 'idle' }, true, true),
		event: { type: 'client-started' },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: false,
			clientEpoch: 5,
			socketEpoch: 7,
		},
		commands: [
			{ type: 'clear-online-listener' },
			{ type: 'clear-grace-timer' },
			{ type: 'retire-client' },
			{ type: 'pause-telemetry' },
			{ type: 'invalidate-session' },
		],
	},
	{
		name: "cleanup { name: 'idle' }",
		previous: base({ name: 'idle' }, true, true),
		event: { type: 'cleaned-up', reason },
		expected: { phase: { name: 'idle' }, resumePending: false, rejoinArmed: false, clientEpoch: 5, socketEpoch: 7 },
		commands: [
			{ type: 'clear-telemetry' },
			{ type: 'cancel-session', reason },
			{ type: 'clear-online-listener' },
			{ type: 'clear-grace-timer' },
			{ type: 'retire-client' },
		],
	},
	{
		name: "join { name: 'idle' }",
		previous: base({ name: 'idle' }, false, false),
		event: { type: 'join-completed', passwordChangeRequired: false },
		expected: { phase: { name: 'idle' }, resumePending: false, rejoinArmed: false, clientEpoch: 4, socketEpoch: 7 },
		commands: [],
	},
	{
		name: "authenticate { name: 'idle' }",
		previous: base({ name: 'idle' }, false, true),
		event: { type: 'session-authenticated' },
		expected: { phase: { name: 'idle' }, resumePending: false, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [],
	},
	{
		name: "disarm { name: 'idle' }",
		previous: base({ name: 'idle' }, true, true),
		event: { type: 'rejoin-disarmed' },
		expected: { phase: { name: 'idle' }, resumePending: true, rejoinArmed: false, clientEpoch: 4, socketEpoch: 7 },
		commands: [],
	},
	{
		name: "observe { name: 'idle' }",
		previous: base({ name: 'idle' }, true, true),
		event: { type: 'socket-observed-closed', now: 1000 },
		expected: { phase: { name: 'idle' }, resumePending: true, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [{ type: 'invalidate-session' }],
	},
	{
		name: "close { name: 'idle' }",
		previous: base({ name: 'idle' }, false, true),
		event: { type: 'socket-closed', terminal: false, now: 1000 },
		expected: { phase: { name: 'idle' }, resumePending: true, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [
			{ type: 'invalidate-session' },
			{ type: 'pause-telemetry' },
			{ type: 'clear-online-listener' },
			{ type: 'voice-socket-dropped' },
			{ type: 'arm-grace-timer', delayMs: 20000 },
		],
	},
	{
		name: "terminal { name: 'idle' }",
		previous: base({ name: 'idle' }, false, true),
		event: { type: 'socket-closed', terminal: true, now: 1000 },
		expected: { phase: { name: 'idle' }, resumePending: false, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [{ type: 'invalidate-session' }, { type: 'pause-telemetry' }, { type: 'clear-online-listener' }],
	},
	{
		name: "start { name: 'connecting' }",
		previous: base({ name: 'connecting' }, true, true),
		event: { type: 'client-started' },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: false,
			clientEpoch: 5,
			socketEpoch: 7,
		},
		commands: [
			{ type: 'clear-online-listener' },
			{ type: 'clear-grace-timer' },
			{ type: 'retire-client' },
			{ type: 'pause-telemetry' },
			{ type: 'invalidate-session' },
		],
	},
	{
		name: "cleanup { name: 'connecting' }",
		previous: base({ name: 'connecting' }, true, true),
		event: { type: 'cleaned-up', reason },
		expected: { phase: { name: 'idle' }, resumePending: false, rejoinArmed: false, clientEpoch: 5, socketEpoch: 7 },
		commands: [
			{ type: 'clear-telemetry' },
			{ type: 'cancel-session', reason },
			{ type: 'clear-online-listener' },
			{ type: 'clear-grace-timer' },
			{ type: 'retire-client' },
		],
	},
	{
		name: "join { name: 'connecting' }",
		previous: base({ name: 'connecting' }, false, false),
		event: { type: 'join-completed', passwordChangeRequired: false },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [],
	},
	{
		name: "authenticate { name: 'connecting' }",
		previous: base({ name: 'connecting' }, false, true),
		event: { type: 'session-authenticated' },
		expected: { phase: { name: 'ready' }, resumePending: false, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [
			{ type: 'clear-grace-timer' },
			{ type: 'authenticate-session' },
			{ type: 'voice-session-authenticated' },
			{ type: 'authenticate-telemetry' },
		],
	},
	{
		name: "disarm { name: 'connecting' }",
		previous: base({ name: 'connecting' }, true, true),
		event: { type: 'rejoin-disarmed' },
		expected: {
			phase: { name: 'connecting' },
			resumePending: true,
			rejoinArmed: false,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [],
	},
	{
		name: "observe { name: 'connecting' }",
		previous: base({ name: 'connecting' }, true, true),
		event: { type: 'socket-observed-closed', now: 1000 },
		expected: { phase: { name: 'connecting' }, resumePending: true, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [{ type: 'invalidate-session' }],
	},
	{
		name: "close { name: 'connecting' }",
		previous: base({ name: 'connecting' }, false, true),
		event: { type: 'socket-closed', terminal: false, now: 1000 },
		expected: { phase: { name: 'connecting' }, resumePending: true, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [
			{ type: 'invalidate-session' },
			{ type: 'pause-telemetry' },
			{ type: 'clear-online-listener' },
			{ type: 'voice-socket-dropped' },
			{ type: 'arm-grace-timer', delayMs: 20000 },
		],
	},
	{
		name: "terminal { name: 'connecting' }",
		previous: base({ name: 'connecting' }, false, true),
		event: { type: 'socket-closed', terminal: true, now: 1000 },
		expected: { phase: { name: 'idle' }, resumePending: false, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [{ type: 'invalidate-session' }, { type: 'pause-telemetry' }, { type: 'clear-online-listener' }],
	},
	{
		name: "start { name: 'ready' }",
		previous: base({ name: 'ready' }, true, true),
		event: { type: 'client-started' },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: false,
			clientEpoch: 5,
			socketEpoch: 7,
		},
		commands: [
			{ type: 'clear-online-listener' },
			{ type: 'clear-grace-timer' },
			{ type: 'retire-client' },
			{ type: 'pause-telemetry' },
			{ type: 'invalidate-session' },
		],
	},
	{
		name: "cleanup { name: 'ready' }",
		previous: base({ name: 'ready' }, true, true),
		event: { type: 'cleaned-up', reason },
		expected: { phase: { name: 'idle' }, resumePending: false, rejoinArmed: false, clientEpoch: 5, socketEpoch: 7 },
		commands: [
			{ type: 'clear-telemetry' },
			{ type: 'cancel-session', reason },
			{ type: 'clear-online-listener' },
			{ type: 'clear-grace-timer' },
			{ type: 'retire-client' },
		],
	},
	{
		name: "join { name: 'ready' }",
		previous: base({ name: 'ready' }, false, false),
		event: { type: 'join-completed', passwordChangeRequired: false },
		expected: { phase: { name: 'ready' }, resumePending: false, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [],
	},
	{
		name: "authenticate { name: 'ready' }",
		previous: base({ name: 'ready' }, false, true),
		event: { type: 'session-authenticated' },
		expected: { phase: { name: 'ready' }, resumePending: false, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [
			{ type: 'clear-grace-timer' },
			{ type: 'authenticate-session' },
			{ type: 'voice-session-authenticated' },
			{ type: 'authenticate-telemetry' },
		],
	},
	{
		name: "disarm { name: 'ready' }",
		previous: base({ name: 'ready' }, true, true),
		event: { type: 'rejoin-disarmed' },
		expected: { phase: { name: 'ready' }, resumePending: true, rejoinArmed: false, clientEpoch: 4, socketEpoch: 7 },
		commands: [],
	},
	{
		name: "observe { name: 'ready' }",
		previous: base({ name: 'ready' }, true, true),
		event: { type: 'socket-observed-closed', now: 1000 },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: true,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'invalidate-session' }],
	},
	{
		name: "close { name: 'ready' }",
		previous: base({ name: 'ready' }, false, true),
		event: { type: 'socket-closed', terminal: false, now: 1000 },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: true,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [
			{ type: 'invalidate-session' },
			{ type: 'pause-telemetry' },
			{ type: 'clear-online-listener' },
			{ type: 'voice-socket-dropped' },
			{ type: 'arm-grace-timer', delayMs: 45000 },
		],
	},
	{
		name: "terminal { name: 'ready' }",
		previous: base({ name: 'ready' }, false, true),
		event: { type: 'socket-closed', terminal: true, now: 1000 },
		expected: { phase: { name: 'idle' }, resumePending: false, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [{ type: 'invalidate-session' }, { type: 'pause-telemetry' }, { type: 'clear-online-listener' }],
	},
	{
		name: "start { name: 'recovering', since: 1000 }",
		previous: base({ name: 'recovering', since: 1000 }, true, true),
		event: { type: 'client-started' },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: false,
			rejoinArmed: false,
			clientEpoch: 5,
			socketEpoch: 7,
		},
		commands: [{ type: 'retire-client' }, { type: 'pause-telemetry' }, { type: 'invalidate-session' }],
	},
	{
		name: "cleanup { name: 'recovering', since: 1000 }",
		previous: base({ name: 'recovering', since: 1000 }, true, true),
		event: { type: 'cleaned-up', reason },
		expected: { phase: { name: 'idle' }, resumePending: false, rejoinArmed: false, clientEpoch: 5, socketEpoch: 7 },
		commands: [
			{ type: 'clear-telemetry' },
			{ type: 'cancel-session', reason },
			{ type: 'clear-online-listener' },
			{ type: 'clear-grace-timer' },
			{ type: 'retire-client' },
		],
	},
	{
		name: "join { name: 'recovering', since: 1000 }",
		previous: base({ name: 'recovering', since: 1000 }, false, false),
		event: { type: 'join-completed', passwordChangeRequired: false },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [],
	},
	{
		name: "authenticate { name: 'recovering', since: 1000 }",
		previous: base({ name: 'recovering', since: 1000 }, false, true),
		event: { type: 'session-authenticated' },
		expected: { phase: { name: 'ready' }, resumePending: false, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [
			{ type: 'clear-grace-timer' },
			{ type: 'authenticate-session' },
			{ type: 'voice-session-authenticated' },
			{ type: 'authenticate-telemetry' },
		],
	},
	{
		name: "disarm { name: 'recovering', since: 1000 }",
		previous: base({ name: 'recovering', since: 1000 }, true, true),
		event: { type: 'rejoin-disarmed' },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: true,
			rejoinArmed: false,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [],
	},
	{
		name: "observe { name: 'recovering', since: 1000 }",
		previous: base({ name: 'recovering', since: 1000 }, true, true),
		event: { type: 'socket-observed-closed', now: 1000 },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: true,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'invalidate-session' }],
	},
	{
		name: "close { name: 'recovering', since: 1000 }",
		previous: base({ name: 'recovering', since: 1000 }, false, true),
		event: { type: 'socket-closed', terminal: false, now: 1000 },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: true,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [
			{ type: 'invalidate-session' },
			{ type: 'pause-telemetry' },
			{ type: 'clear-online-listener' },
			{ type: 'voice-socket-dropped' },
			{ type: 'arm-grace-timer', delayMs: 45000 },
		],
	},
	{
		name: "terminal { name: 'recovering', since: 1000 }",
		previous: base({ name: 'recovering', since: 1000 }, false, true),
		event: { type: 'socket-closed', terminal: true, now: 1000 },
		expected: { phase: { name: 'idle' }, resumePending: false, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [{ type: 'invalidate-session' }, { type: 'pause-telemetry' }, { type: 'clear-online-listener' }],
	},
	{
		name: 'open ("{ name: \'connecting\' }", False, True, True, True)',
		previous: base({ name: 'connecting' }, false, true),
		event: { type: 'socket-opened', now: 1000, online: true, socketOpen: true },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 8,
		},
		commands: [{ type: 'pause-telemetry' }, { type: 'invalidate-session' }],
	},
	{
		name: 'open ("{ name: \'connecting\' }", True, True, False, True)',
		previous: base({ name: 'connecting' }, true, true),
		event: { type: 'socket-opened', now: 1000, online: false, socketOpen: true },
		expected: { phase: { name: 'connecting' }, resumePending: true, rejoinArmed: true, clientEpoch: 4, socketEpoch: 8 },
		commands: [{ type: 'pause-telemetry' }, { type: 'invalidate-session' }, { type: 'await-online' }],
	},
	{
		name: 'open ("{ name: \'connecting\' }", True, True, True, False)',
		previous: base({ name: 'connecting' }, true, true),
		event: { type: 'socket-opened', now: 1000, online: true, socketOpen: false },
		expected: { phase: { name: 'connecting' }, resumePending: true, rejoinArmed: true, clientEpoch: 4, socketEpoch: 8 },
		commands: [{ type: 'pause-telemetry' }, { type: 'invalidate-session' }, { type: 'clear-online-listener' }],
	},
	{
		name: 'open ("{ name: \'connecting\' }", True, False, True, True)',
		previous: base({ name: 'connecting' }, true, false),
		event: { type: 'socket-opened', now: 1000, online: true, socketOpen: true },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: false,
			clientEpoch: 4,
			socketEpoch: 8,
		},
		commands: [
			{ type: 'pause-telemetry' },
			{ type: 'invalidate-session' },
			{ type: 'clear-online-listener' },
			{ type: 'clear-grace-timer' },
		],
	},
	{
		name: 'open ("{ name: \'connecting\' }", True, True, True, True)',
		previous: base({ name: 'connecting' }, true, true),
		event: { type: 'socket-opened', now: 1000, online: true, socketOpen: true },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 8,
		},
		commands: [
			{ type: 'pause-telemetry' },
			{ type: 'invalidate-session' },
			{ type: 'clear-online-listener' },
			{ type: 'clear-grace-timer' },
			{ type: 'run-rejoin' },
		],
	},
	{
		name: 'online ("{ name: \'connecting\' }", False, False, True)',
		previous: base({ name: 'connecting' }, false, false),
		event: { type: 'online', now: 30000, socketOpen: true },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: false,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'clear-online-listener' }],
	},
	{
		name: 'online ("{ name: \'connecting\' }", True, True, False)',
		previous: base({ name: 'connecting' }, true, true),
		event: { type: 'online', now: 30000, socketOpen: false },
		expected: { phase: { name: 'connecting' }, resumePending: true, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [{ type: 'clear-online-listener' }],
	},
	{
		name: 'online ("{ name: \'connecting\' }", True, False, True)',
		previous: base({ name: 'connecting' }, true, false),
		event: { type: 'online', now: 30000, socketOpen: true },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: false,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'clear-online-listener' }, { type: 'clear-grace-timer' }],
	},
	{
		name: 'online ("{ name: \'connecting\' }", True, True, True)',
		previous: base({ name: 'connecting' }, true, true),
		event: { type: 'online', now: 30000, socketOpen: true },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'clear-online-listener' }, { type: 'clear-grace-timer' }, { type: 'run-rejoin' }],
	},
	{
		name: 'expiry ("{ name: \'connecting\' }", False, True)',
		previous: base({ name: 'connecting' }, false, true),
		event: { type: 'grace-expired', online: true },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [],
	},
	{
		name: 'expiry ("{ name: \'connecting\' }", True, True)',
		previous: base({ name: 'connecting' }, true, true),
		event: { type: 'grace-expired', online: true },
		expected: {
			phase: { name: 'connecting' },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'teardown-to-disconnect-screen' }],
	},
	{
		name: 'expiry ("{ name: \'connecting\' }", True, False)',
		previous: base({ name: 'connecting' }, true, true),
		event: { type: 'grace-expired', online: false },
		expected: { phase: { name: 'connecting' }, resumePending: true, rejoinArmed: true, clientEpoch: 4, socketEpoch: 7 },
		commands: [{ type: 'arm-grace-timer', delayMs: 20000 }],
	},
	{
		name: 'open ("{ name: \'recovering\', since: 1000 }", False, True, True, True)',
		previous: base({ name: 'recovering', since: 1000 }, false, true),
		event: { type: 'socket-opened', now: 1000, online: true, socketOpen: true },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 8,
		},
		commands: [{ type: 'pause-telemetry' }, { type: 'invalidate-session' }],
	},
	{
		name: 'open ("{ name: \'recovering\', since: 1000 }", True, True, False, True)',
		previous: base({ name: 'recovering', since: 1000 }, true, true),
		event: { type: 'socket-opened', now: 1000, online: false, socketOpen: true },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: true,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 8,
		},
		commands: [{ type: 'pause-telemetry' }, { type: 'invalidate-session' }, { type: 'await-online' }],
	},
	{
		name: 'open ("{ name: \'recovering\', since: 1000 }", True, True, True, False)',
		previous: base({ name: 'recovering', since: 1000 }, true, true),
		event: { type: 'socket-opened', now: 1000, online: true, socketOpen: false },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: true,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 8,
		},
		commands: [{ type: 'pause-telemetry' }, { type: 'invalidate-session' }, { type: 'clear-online-listener' }],
	},
	{
		name: 'open ("{ name: \'recovering\', since: 1000 }", True, False, True, True)',
		previous: base({ name: 'recovering', since: 1000 }, true, false),
		event: { type: 'socket-opened', now: 1000, online: true, socketOpen: true },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: false,
			rejoinArmed: false,
			clientEpoch: 4,
			socketEpoch: 8,
		},
		commands: [{ type: 'pause-telemetry' }, { type: 'invalidate-session' }, { type: 'clear-online-listener' }],
	},
	{
		name: 'open ("{ name: \'recovering\', since: 1000 }", True, True, True, True)',
		previous: base({ name: 'recovering', since: 1000 }, true, true),
		event: { type: 'socket-opened', now: 1000, online: true, socketOpen: true },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 8,
		},
		commands: [
			{ type: 'pause-telemetry' },
			{ type: 'invalidate-session' },
			{ type: 'clear-online-listener' },
			{ type: 'run-rejoin' },
		],
	},
	{
		name: 'online ("{ name: \'recovering\', since: 1000 }", False, False, True)',
		previous: base({ name: 'recovering', since: 1000 }, false, false),
		event: { type: 'online', now: 30000, socketOpen: true },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: false,
			rejoinArmed: false,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'clear-online-listener' }],
	},
	{
		name: 'online ("{ name: \'recovering\', since: 1000 }", True, True, False)',
		previous: base({ name: 'recovering', since: 1000 }, true, true),
		event: { type: 'online', now: 30000, socketOpen: false },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: true,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'clear-online-listener' }],
	},
	{
		name: 'online ("{ name: \'recovering\', since: 1000 }", True, False, True)',
		previous: base({ name: 'recovering', since: 1000 }, true, false),
		event: { type: 'online', now: 30000, socketOpen: true },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: false,
			rejoinArmed: false,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'clear-online-listener' }],
	},
	{
		name: 'online ("{ name: \'recovering\', since: 1000 }", True, True, True)',
		previous: base({ name: 'recovering', since: 1000 }, true, true),
		event: { type: 'online', now: 30000, socketOpen: true },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'clear-online-listener' }, { type: 'run-rejoin' }],
	},
	{
		name: 'expiry ("{ name: \'recovering\', since: 1000 }", False, True)',
		previous: base({ name: 'recovering', since: 1000 }, false, true),
		event: { type: 'grace-expired', online: true },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'teardown-to-disconnect-screen' }],
	},
	{
		name: 'expiry ("{ name: \'recovering\', since: 1000 }", True, True)',
		previous: base({ name: 'recovering', since: 1000 }, true, true),
		event: { type: 'grace-expired', online: true },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: false,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'teardown-to-disconnect-screen' }],
	},
	{
		name: 'expiry ("{ name: \'recovering\', since: 1000 }", True, False)',
		previous: base({ name: 'recovering', since: 1000 }, true, true),
		event: { type: 'grace-expired', online: false },
		expected: {
			phase: { name: 'recovering', since: 1000 },
			resumePending: true,
			rejoinArmed: true,
			clientEpoch: 4,
			socketEpoch: 7,
		},
		commands: [{ type: 'arm-grace-timer', delayMs: 20000 }, { type: 'await-online' }],
	},
];
describe('literal connection transitions', () => {
	for (const row of rows)
		test(row.name, () => {
			expect(reduceConnection(row.previous, row.event)).toEqual({ state: row.expected, commands: row.commands });
		});
});

test('gate authentication agrees with phase after every prefix of all sequences up to three events', () => {
	const visit = (state: TConnectionState, authenticated: boolean, depth: number) => {
		if (!depth) return;
		for (const event of events) {
			const snapshot = structuredClone(state);
			const result = reduceConnection(state, event);
			expect(state).toEqual(snapshot);
			for (const [index, command] of result.commands.entries()) {
				if (command.type === 'run-rejoin' || command.type === 'teardown-to-disconnect-screen') {
					expect(index).toBe(result.commands.length - 1);
				}
			}
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
	// Seed every phase and flag combination so three-event prefixes include
	// deadline expiry and password-change transitions from active recovery.
	const phases: TConnectionState['phase'][] = [
		{ name: 'idle' },
		{ name: 'connecting' },
		{ name: 'ready' },
		{ name: 'recovering', since: 20 },
	];
	for (const phase of phases) {
		for (const pending of [false, true]) {
			for (const armed of [false, true]) {
				visit(base(phase, pending, armed), phase.name === 'ready', 3);
			}
		}
	}
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
	store.dispatch({ type: 'join-completed', passwordChangeRequired: false });
	expect(store.getState()).toBe(initial);
	expect(calls).toEqual([]);
	store.dispatch({ type: 'client-started' });
	expect(calls).toEqual([{ state: store.getState(), previous: initial }]);
	unsubscribe();
	store.dispatch({ type: 'cleaned-up', reason });
	expect(calls.length).toBe(1);
});

const recovery = base({ name: 'recovering', since: 1000 }, true, true);
const deadlineRows: { name: string; event: TConnectionEvent; commands: TConnectionCommand[]; pending: boolean }[] = [
	{
		name: 'second close shrinks budget',
		event: { type: 'socket-closed', terminal: false, now: 11000 },
		commands: [
			{ type: 'invalidate-session' },
			{ type: 'pause-telemetry' },
			{ type: 'clear-online-listener' },
			{ type: 'voice-socket-dropped' },
			{ type: 'arm-grace-timer', delayMs: 35000 },
		],
		pending: true,
	},
	{
		name: 'overdue close has zero budget',
		event: { type: 'socket-closed', terminal: false, now: 50000 },
		commands: [
			{ type: 'invalidate-session' },
			{ type: 'pause-telemetry' },
			{ type: 'clear-online-listener' },
			{ type: 'voice-socket-dropped' },
			{ type: 'arm-grace-timer', delayMs: 0 },
		],
		pending: true,
	},
	{
		name: 'online one millisecond before deadline resumes',
		event: { type: 'online', now: 45999, socketOpen: true },
		commands: [{ type: 'clear-online-listener' }, { type: 'run-rejoin' }],
		pending: false,
	},
	{
		name: 'online at deadline with open socket tears down',
		event: { type: 'online', now: 46000, socketOpen: true },
		commands: [{ type: 'clear-online-listener' }, { type: 'teardown-to-disconnect-screen' }],
		pending: false,
	},
	{
		name: 'online at deadline with closed socket tears down',
		event: { type: 'online', now: 46000, socketOpen: false },
		commands: [{ type: 'clear-online-listener' }, { type: 'teardown-to-disconnect-screen' }],
		pending: false,
	},
];
for (const row of deadlineRows)
	test(row.name, () => {
		expect(reduceConnection(recovery, row.event)).toEqual({
			state: { ...recovery, resumePending: row.pending },
			commands: row.commands,
		});
	});
for (const socketOpen of [false, true])
	test(`offline expiry, replacement and return online: socket open ${socketOpen}`, () => {
		const expired = reduceConnection(recovery, { type: 'grace-expired', online: false });
		expect(expired).toEqual({
			state: recovery,
			commands: [{ type: 'arm-grace-timer', delayMs: 20000 }, { type: 'await-online' }],
		});
		const replaced = reduceConnection(expired.state, { type: 'client-started' });
		const replacement = { ...recovery, clientEpoch: 5, resumePending: false, rejoinArmed: false };
		expect(replaced).toEqual({
			state: replacement,
			commands: [{ type: 'retire-client' }, { type: 'pause-telemetry' }, { type: 'invalidate-session' }],
		});
		let state = replaced.state;
		if (socketOpen) {
			const opened = reduceConnection(state, { type: 'socket-opened', now: 47500, online: false, socketOpen: true });
			expect(opened).toEqual({
				state: { ...replacement, socketEpoch: 8 },
				commands: [{ type: 'pause-telemetry' }, { type: 'invalidate-session' }],
			});
			state = opened.state;
		}
		expect(reduceConnection(state, { type: 'online', now: 48000, socketOpen })).toEqual({
			state,
			commands: [{ type: 'clear-online-listener' }, { type: 'teardown-to-disconnect-screen' }],
		});
		expect(reduceConnection(state, { type: 'online', now: 30000, socketOpen: true })).toEqual({
			state,
			commands: [{ type: 'clear-online-listener' }],
		});
		const authenticated = reduceConnection(state, { type: 'session-authenticated' });
		expect(authenticated.commands).toEqual([
			{ type: 'clear-grace-timer' },
			{ type: 'authenticate-session' },
			{ type: 'voice-session-authenticated' },
			{ type: 'authenticate-telemetry' },
		]);
		expect(authenticated.state.phase).toEqual({ name: 'ready' });
		expect(reduceConnection(authenticated.state, { type: 'grace-expired', online: true }).commands).toEqual([]);
		expect(reduceConnection(authenticated.state, { type: 'online', now: 48000, socketOpen: true }).commands).toEqual([
			{ type: 'clear-online-listener' },
		]);
		const cleaned = reduceConnection(state, { type: 'cleaned-up', reason });
		expect(cleaned.state.phase).toEqual({ name: 'idle' });
		expect(cleaned.commands).toEqual([
			{ type: 'clear-telemetry' },
			{ type: 'cancel-session', reason },
			{ type: 'clear-online-listener' },
			{ type: 'clear-grace-timer' },
			{ type: 'retire-client' },
		]);
		expect(reduceConnection(cleaned.state, { type: 'online', now: 48000, socketOpen: false }).commands).toEqual([
			{ type: 'clear-online-listener' },
		]);
	});
test('password form ends recovery, ordinary completion on a closing socket does not', () => {
	expect(reduceConnection(recovery, { type: 'join-completed', passwordChangeRequired: true })).toEqual({
		state: { ...recovery, phase: { name: 'connecting' } },
		commands: [{ type: 'clear-grace-timer' }],
	});
	const joined = reduceConnection(recovery, { type: 'join-completed', passwordChangeRequired: false });
	expect(joined).toEqual({ state: recovery, commands: [] });
	expect(reduceConnection(joined.state, { type: 'grace-expired', online: true })).toEqual({
		state: { ...recovery, resumePending: false },
		commands: [{ type: 'teardown-to-disconnect-screen' }],
	});
});

test('open without a close starts recovery without arming, while stale expiries cannot end healthy or idle sessions', () => {
	const ready = base({ name: 'ready' }, false, true);
	expect(reduceConnection(ready, { type: 'socket-opened', online: true, socketOpen: true, now: 1000 })).toEqual({
		state: { ...ready, phase: { name: 'recovering', since: 1000 }, socketEpoch: 8 },
		commands: [{ type: 'pause-telemetry' }, { type: 'invalidate-session' }],
	});
	const healthyWithPendingResume = base({ name: 'ready' }, true, true);
	const idleWithPendingResume = base({ name: 'idle' }, true, true);
	expect(reduceConnection(healthyWithPendingResume, { type: 'grace-expired', online: true })).toEqual({
		state: healthyWithPendingResume,
		commands: [],
	});
	expect(reduceConnection(idleWithPendingResume, { type: 'grace-expired', online: false })).toEqual({
		state: idleWithPendingResume,
		commands: [],
	});
	expect(reduceConnection(ready, { type: 'online', now: 100000, socketOpen: true })).toEqual({
		state: ready,
		commands: [{ type: 'clear-online-listener' }],
	});
	const stalled = base({ name: 'recovering', since: 1000 }, false, true);
	expect(reduceConnection(stalled, { type: 'online', now: 46000, socketOpen: true })).toEqual({
		state: stalled,
		commands: [{ type: 'clear-online-listener' }, { type: 'teardown-to-disconnect-screen' }],
	});
	const connecting = base({ name: 'connecting' }, true, true);
	expect(reduceConnection(connecting, { type: 'socket-closed', terminal: false, now: 11000 })).toEqual({
		state: connecting,
		commands: [
			{ type: 'invalidate-session' },
			{ type: 'pause-telemetry' },
			{ type: 'clear-online-listener' },
			{ type: 'voice-socket-dropped' },
			{ type: 'arm-grace-timer', delayMs: 20000 },
		],
	});
	expect(reduceConnection(connecting, { type: 'online', now: 100000, socketOpen: true })).toEqual({
		state: { ...connecting, resumePending: false },
		commands: [{ type: 'clear-online-listener' }, { type: 'clear-grace-timer' }, { type: 'run-rejoin' }],
	});
	expect(reduceConnection(connecting, { type: 'join-completed', passwordChangeRequired: true })).toEqual({
		state: connecting,
		commands: [],
	});
});
