import { expect, test } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { createRemoteMediaCommandRunner } from '../remote-media-command-runner';
import { createRemoteMediaConsumeController, type TServerConsumerAllocation } from '../remote-media-consume-controller';
import { createRemoteMediaIntegration, type TRemoteMediaIntegrationInputs } from '../remote-media-integration';
import { createRemoteMediaLedgerStore } from '../remote-media-ledger-store';
import {
	clearRemoteMediaForTransport,
	clearRemoteMediaForTransportFailure,
	stopRemoteMediaWatch,
} from '../remote-media-lifecycle';
import type { TRemoteMediaCommand } from '../remote-media-subscriptions';
import {
	markRemoteConsumeFailed,
	markRemoteConsumerClosed,
	markRemoteConsumeStarted,
	markRemoteConsumeSucceeded,
	markRemoteProducerClosed,
	markRemoteProducerPresent,
	markRemoteRetryRequested,
	markRemoteWatchRequested,
	markRemoteWatchStopped,
} from '../remote-media-subscriptions';
import { getPendingStreamKey } from '../use-pending-streams';

const deferred = <T>() => {
	let resolve: (value: T) => void = () => {
		throw new Error('uninitialized');
	};
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
};
const flush = async () => {
	for (let i = 0; i < 40; i++) await Promise.resolve();
};
type TLocal = { id: string; producerId: string; closed: boolean; closeCount: number };
const fixture = () => {
	const store = createRemoteMediaLedgerStore({ now: () => 1 });
	const allocations: {
		producerId: string | undefined;
		kind: StreamKind;
		result: ReturnType<typeof deferred<TServerConsumerAllocation<object>>>;
	}[] = [];
	const resumes: { id: string; result: ReturnType<typeof deferred<void>> }[] = [];
	const closes: (string | undefined)[] = [];
	const locals: TLocal[] = [];
	const attached: string[] = [];
	const detached: string[] = [];
	const successes: string[] = [];
	const starts: StreamKind[] = [];
	const commands: TRemoteMediaCommand[] = [];
	const startBoundaries: {
		producerId: string | undefined;
		consumerId: string | undefined;
		commandsBefore: number;
		commandsAfter: number;
		signal: AbortSignal;
	}[] = [];
	const closeBoundaries: { consumerId: string | undefined; slotConsumerId: string | undefined }[] = [];
	const inputs: TRemoteMediaIntegrationInputs = {
		ledgerStore: store,
		currentVoiceChannelId: 5,
		currentChannelExternalStreams: {},
		externalStreams: {},
		getRtpCapabilities: () => ({}),
		markConsumeStarted: (id, kind, producer, generation, manual) =>
			store.dispatch((prev, now) => markRemoteConsumeStarted(prev, id, kind, now, producer, generation, manual)),
		markWatchRequested: (id, kind, tracks) =>
			store.dispatch((prev, now) => markRemoteWatchRequested(prev, id, kind, now, { externalStreamTracks: tracks })),
		markRetryRequested: (id, kind, tracks) =>
			store.dispatch((prev, now) => markRemoteRetryRequested(prev, id, kind, now, { externalStreamTracks: tracks })),
		addPendingStream: (id, kind, producer, tracks) =>
			store.dispatch((prev, now) =>
				markRemoteProducerPresent(prev, id, kind, now, producer, { externalStreamTracks: tracks }),
			),
		clearRemoteMediaExternalStream: () => {},
		removeExternalStream: () => {},
		log: () => {},
	};
	const integration = createRemoteMediaIntegration(() => inputs);
	integration.activate();
	const controller = createRemoteMediaConsumeController<{ id: string }, TLocal, RtpCapabilities, object>({
		delay: () => new Promise(() => {}),
		getTransportId: (t) => t.id,
		isTransportClosed: () => false,
		consumeOnServer: (request) => {
			const result = deferred<TServerConsumerAllocation<object>>();
			allocations.push({ producerId: request.expectedProducerId, kind: request.kind, result });
			return result.promise;
		},
		resumeServerConsumer: (target) => {
			const result = deferred<void>();
			resumes.push({ id: target.consumerId, result });
			return result.promise;
		},
		closeServerConsumer: async (target) => {
			closes.push(target.consumerId);
		},
		createLocalConsumer: async (_transport, allocation) => {
			const local = { id: allocation.consumerId, producerId: allocation.producerId, closed: false, closeCount: 0 };
			locals.push(local);
			return local;
		},
		closeLocalConsumer: (local) => {
			local.closed = true;
			local.closeCount++;
		},
		isLocalConsumerClosed: (local) => local.closed,
		observeLocalConsumerClosed: () => {},
		attachLocalConsumer: (_request, local) => {
			attached.push(local.id);
			return () => {
				detached.push(local.id);
			};
		},
		isProducerCurrent: integration.isRemoteMediaProducerCurrent,
		onConsumeStarted: (request, token, signal) => {
			starts.push(request.kind);
			const commandsBefore = commands.length;
			const consumerId = store.getSnapshot().get(getPendingStreamKey(request.remoteId, request.kind))?.consumerId;
			const answer = integration.publishRemoteMediaConsumeStarted(
				request.remoteId,
				request.kind,
				request.expectedProducerId,
				token,
				request.isManualRetry ?? false,
				signal,
			);
			startBoundaries.push({
				producerId: request.expectedProducerId,
				consumerId,
				commandsBefore,
				commandsAfter: commands.length,
				signal,
			});
			// A direct screen start must synchronously enter its sibling before publication returns.
			if (
				request.kind === StreamKind.SCREEN &&
				store.getSnapshot().has(getPendingStreamKey(7, StreamKind.SCREEN_AUDIO))
			)
				expect(starts).toContain(StreamKind.SCREEN_AUDIO);
			return answer;
		},
		onConsumeSucceeded: (request, result) => {
			successes.push(result.producerId);
			store.dispatch((prev, now) =>
				markRemoteConsumeSucceeded(
					prev,
					request.remoteId,
					request.kind,
					now,
					result.producerId,
					result.consumerId,
					result.operationToken,
				),
			);
		},
		onConsumeFailed: (request, result) =>
			store.dispatch((prev, now) =>
				markRemoteConsumeFailed(prev, request.remoteId, request.kind, now, result.reason, result.operationToken),
			),
		onConsumerClosed: (id, kind, consumer) =>
			store.dispatch((prev, now) => markRemoteConsumerClosed(prev, id, kind, now, consumer)),
	});
	controller.replaceTransport({ id: 'transport' });
	const runner = createRemoteMediaCommandRunner({
		getSnapshot: store.getSnapshot,
		getRtpCapabilities: () => ({}),
		getExternalStreamTrackPresence: () => ({}),
		consume: (remoteId, kind, rtpCapabilities, expectedProducerId, options) =>
			controller.consume({ remoteId, kind, rtpCapabilities, expectedProducerId, ...options }),
		closeConsumer: controller.closeConsumer,
	});
	store.setCommandRunner((command) => {
		commands.push(command);
		if (command.type === 'closeConsumer')
			closeBoundaries.push({
				consumerId: command.consumerId,
				slotConsumerId: store.getSnapshot().get(getPendingStreamKey(command.remoteId, command.kind))?.consumerId,
			});
		runner(command);
	});
	const present = (producer = 'p1', kind = StreamKind.VIDEO) => inputs.addPendingStream(7, kind, producer);
	const watch = (kind = StreamKind.VIDEO) => integration.acceptStream(7, kind);
	const stop = (kind = StreamKind.VIDEO) => {
		stopRemoteMediaWatch(7, kind, {
			markWatchStopped: (id, streamKind) =>
				store.dispatch((prev, now) => markRemoteWatchStopped(prev, id, streamKind, now)),
			cancel: controller.cancel,
		});
	};
	const replace = () => {
		store.dispatch((prev, now) =>
			markRemoteProducerClosed(prev, 7, StreamKind.VIDEO, now, 'p1', { preserveDesired: true }),
		);
		present('p2');
	};
	const resolveAllocation = (producer = 'p1') => {
		const allocation = allocations.find((a) => a.producerId === producer);
		if (!allocation) throw new Error('missing allocation');
		allocation.result.resolve({
			producerId: producer,
			consumerId: `c-${producer}`,
			consumerKind: allocation.kind,
			consumerRtpParameters: {},
		});
	};
	const resolveResume = (producer = 'p1') => {
		const resume = resumes.find((r) => r.id === `c-${producer}`);
		if (!resume) throw new Error('missing resume');
		resume.result.resolve();
	};
	const slot = (kind = StreamKind.VIDEO) => store.getSnapshot().get(getPendingStreamKey(7, kind));
	return {
		integration,
		commands,
		startBoundaries,
		closeBoundaries,
		store,
		controller,
		allocations,
		resumes,
		closes,
		locals,
		attached,
		detached,
		successes,
		present,
		watch,
		stop,
		replace,
		resolveAllocation,
		resolveResume,
		slot,
	};
};
for (const direct of [true, false])
	test(`SCREEN cascade without duplicate RPCs (direct=${direct})`, async () => {
		const f = fixture();
		f.present('screen', StreamKind.SCREEN);
		f.present('audio', StreamKind.SCREEN_AUDIO);
		if (direct)
			void f.controller.consume({
				remoteId: 7,
				kind: StreamKind.SCREEN,
				rtpCapabilities: {},
				expectedProducerId: 'screen',
			});
		else f.watch(StreamKind.SCREEN);
		await flush();
		expect(f.allocations.map((a) => a.producerId).sort()).toEqual(['audio', 'screen']);
		for (const producer of ['screen', 'audio']) f.resolveAllocation(producer);
		await flush();
		expect(f.attached.sort()).toEqual(['c-audio', 'c-screen']);
		expect(f.resumes).toHaveLength(2);
		for (const producer of ['screen', 'audio']) f.resolveResume(producer);
		await flush();
		expect(f.successes.sort()).toEqual(['audio', 'screen']);
		expect(f.slot(StreamKind.SCREEN)?.status).toBe('consumed');
		expect(f.slot(StreamKind.SCREEN_AUDIO)?.status).toBe('consumed');
		expect(f.locals).toHaveLength(2);
		expect(f.closes).toEqual([]);
		expect(f.detached).toEqual([]);
	});
for (const boundary of ['allocation', 'resume'])
	test(`stop watching before ${boundary} returns`, async () => {
		const f = fixture();
		f.present();
		f.watch();
		await flush();
		if (boundary === 'resume') {
			f.resolveAllocation();
			await flush();
		}
		f.stop();
		await flush();
		if (boundary === 'allocation') f.resolveAllocation();
		else f.resolveResume();
		await flush();
		expect(f.allocations).toHaveLength(1);
		expect(f.closes).toEqual(['c-p1']);
		expect(f.successes).toEqual([]);
		expect(f.slot()?.status).not.toBe('consumed');
		expect(f.locals).toHaveLength(boundary === 'resume' ? 1 : 0);
		expect(f.resumes).toHaveLength(boundary === 'resume' ? 1 : 0);
		expect(f.attached).toEqual(boundary === 'resume' ? ['c-p1'] : []);
		expect(f.detached).toEqual(f.attached);
		for (const local of f.locals) expect(local.closeCount).toBe(1);
	});
for (const boundary of ['allocation', 'resume'])
	test(`producer replacement at ${boundary}`, async () => {
		const f = fixture();
		f.present();
		f.watch();
		await flush();
		if (boundary !== 'allocation') {
			f.resolveAllocation();
			await flush();
		}
		f.replace();
		await flush();
		expect(f.allocations).toHaveLength(2);
		if (boundary === 'allocation') f.resolveAllocation();
		if (boundary === 'resume') f.resolveResume();
		f.resolveAllocation('p2');
		await flush();
		f.resolveResume('p2');
		await flush();
		expect(f.slot()?.status).toBe('consumed');
		expect(f.slot()?.producerId).toBe('p2');
		expect(f.closes).toEqual(['c-p1']);
		expect(f.attached).toEqual(boundary === 'allocation' ? ['c-p2'] : ['c-p1', 'c-p2']);
		expect(f.detached).toEqual(boundary === 'allocation' ? [] : ['c-p1']);
		expect(f.resumes.map((r) => r.id)).toEqual(boundary === 'allocation' ? ['c-p2'] : ['c-p1', 'c-p2']);
		expect(f.successes).toEqual(['p2']);
		expect(f.locals).toHaveLength(boundary === 'allocation' ? 1 : 2);
		for (const local of f.locals) expect(local.closeCount).toBe(local.producerId === 'p1' ? 1 : 0);
	});
test('live replacement closes c1 at producer-present before starting p2', async () => {
	const f = fixture();
	f.present();
	f.watch();
	await flush();
	f.resolveAllocation();
	await flush();
	f.resolveResume();
	await flush();
	expect(f.slot()?.status).toBe('consumed');
	expect(f.slot()?.consumerId).toBe('c-p1');
	const commandCount = f.commands.length;
	f.present('p2');
	expect(f.commands.slice(commandCount)).toEqual([
		{
			type: 'closeConsumer',
			key: getPendingStreamKey(7, StreamKind.VIDEO),
			generation: undefined,
			remoteId: 7,
			kind: StreamKind.VIDEO,
			consumerId: 'c-p1',
		},
		{
			type: 'consume',
			key: getPendingStreamKey(7, StreamKind.VIDEO),
			generation: 1,
			isManualRetry: undefined,
			remoteId: 7,
			kind: StreamKind.VIDEO,
			producerId: 'p2',
		},
	]);
	expect(f.closeBoundaries).toEqual([{ consumerId: 'c-p1', slotConsumerId: undefined }]);
	expect(f.closes).toEqual(['c-p1']);
	expect(f.locals[0]?.closeCount).toBe(1);
	const start = f.startBoundaries.find((boundary) => boundary.producerId === 'p2');
	if (!start) throw new Error('p2 did not start');
	expect(start.consumerId).toBeUndefined();
	expect(start.commandsBefore).toBe(commandCount + 2);
	expect(start.commandsAfter).toBe(start.commandsBefore);
	expect(start.signal.aborted).toBe(false);
	await flush();
	expect(f.allocations.map((allocation) => allocation.producerId)).toEqual(['p1', 'p2']);
	f.resolveAllocation('p2');
	await flush();
	expect(start.signal.aborted).toBe(false);
	f.resolveResume('p2');
	await flush();
	expect(f.slot()?.status).toBe('consumed');
	expect(f.slot()?.producerId).toBe('p2');
	expect(f.slot()?.consumerId).toBe('c-p2');
	expect(f.commands).toHaveLength(commandCount + 2);
	expect(f.closes).toEqual(['c-p1']);
	expect(f.attached).toEqual(['c-p1', 'c-p2']);
	expect(f.detached).toEqual(['c-p1']);
	expect(f.resumes.map((resume) => resume.id)).toEqual(['c-p1', 'c-p2']);
	expect(f.successes).toEqual(['p1', 'p2']);
	expect(f.locals.map((local) => local.closeCount)).toEqual([1, 0]);
});
test('transport cleanup owns the late allocation and drops queued commands', async () => {
	const f = fixture();
	f.present();
	f.watch();
	await flush();
	clearRemoteMediaForTransport(
		{ clear: f.store.clear, invalidateTransport: f.controller.invalidateTransport },
		{ preserveIntent: true },
	);
	f.resolveAllocation();
	await flush();
	expect(f.allocations).toHaveLength(1);
	expect(f.closes).toEqual(['c-p1']);
	expect(f.locals).toEqual([]);
	expect(f.attached).toEqual([]);
	expect(f.resumes).toEqual([]);
	expect(f.successes).toEqual([]);
	expect([...f.store.getSnapshot().values()].some((slot) => slot.status === 'consuming')).toBe(false);
	const pending: unknown[] = [];
	f.store.setCommandRunner((command) => pending.push(command));
	expect(pending).toEqual([]);
});

for (const kind of [StreamKind.VIDEO, StreamKind.SCREEN])
	test(`consumed, then stop ${kind} without re-consuming`, async () => {
		const f = fixture();
		const producers = kind === StreamKind.SCREEN ? ['screen', 'audio'] : ['video'];
		const kinds = kind === StreamKind.SCREEN ? [kind, StreamKind.SCREEN_AUDIO] : [kind];
		f.present(producers[0], kind);
		if (kind === StreamKind.SCREEN) f.present('audio', StreamKind.SCREEN_AUDIO);
		f.watch(kind);
		await flush();
		for (const producer of producers) f.resolveAllocation(producer);
		await flush();
		for (const producer of producers) f.resolveResume(producer);
		await flush();
		for (const slotKind of kinds) expect(f.slot(slotKind)?.status).toBe('consumed');
		const commandCount = f.commands.length;
		f.stop(kind);
		await flush();
		for (const slotKind of kinds) {
			expect(f.slot(slotKind)?.status).toBe('available');
			expect(f.slot(slotKind)?.desired).toBe(false);
			expect(f.controller.getActiveConsumerProducerId(7, slotKind)).toBeUndefined();
			expect(f.allocations.filter((allocation) => allocation.kind === slotKind)).toHaveLength(1);
		}
		expect(f.commands.slice(commandCount).filter((command) => command.type === 'consume')).toEqual([]);
		expect([...f.attached].sort()).toEqual(producers.map((producer) => `c-${producer}`).sort());
		expect([...f.detached].sort()).toEqual([...f.attached].sort());
		expect(f.resumes).toHaveLength(producers.length);
		expect([...f.closes].sort()).toEqual([...f.attached].sort());
		for (const local of f.locals) expect(local.closeCount).toBe(1);
	});

for (const preserveIntent of [false, true])
	test(`transport cleanup of a consumed stream emits no spurious re-consume command (preserve=${preserveIntent})`, async () => {
		const f = fixture();
		f.present();
		f.watch();
		await flush();
		f.resolveAllocation();
		await flush();
		f.resolveResume();
		await flush();
		expect(f.slot()?.status).toBe('consumed');
		const commandCount = f.commands.length;
		clearRemoteMediaForTransport(
			{ clear: f.store.clear, invalidateTransport: f.controller.invalidateTransport },
			{ preserveIntent },
		);
		await flush();
		expect(f.commands).toHaveLength(commandCount);
		expect(f.allocations).toHaveLength(1);
		expect(f.attached).toEqual(['c-p1']);
		expect(f.detached).toEqual(['c-p1']);
		expect(f.locals[0]?.closeCount).toBe(1);
		expect(f.slot()?.producerPresent).not.toBe(true);
		expect(f.slot()?.desired).toBe(preserveIntent ? true : undefined);
	});

test('failed transport preserves watched streams for recovery snapshot, then terminal cleanup discards them', async () => {
	const f = fixture();
	f.present('camera');
	f.watch();
	await flush();
	f.resolveAllocation('camera');
	await flush();
	f.resolveResume('camera');
	await flush();
	expect(f.slot()?.status).toBe('consumed');
	// Include the screen/audio sibling and both external tracks in the real
	// integration snapshot, without starting more transport work.
	f.store.setCommandRunner(undefined);
	f.present('screen', StreamKind.SCREEN);
	f.present('screen-audio', StreamKind.SCREEN_AUDIO);
	for (const kind of [StreamKind.SCREEN, StreamKind.EXTERNAL_VIDEO, StreamKind.EXTERNAL_AUDIO]) {
		f.store.dispatch((prev, now) => markRemoteWatchRequested(prev, 7, kind, now));
	}
	const watched = f.integration.captureWatchedRemoteStreams();
	expect(watched).toEqual({
		remoteUserStreams: { 7: [StreamKind.VIDEO, StreamKind.SCREEN, StreamKind.SCREEN_AUDIO] },
		externalStreams: { 7: { audio: true, video: true } },
	});
	const commandCount = f.commands.length;
	const ports = { clear: f.store.clear, invalidateTransport: f.controller.invalidateTransport };
	// Both failed-state and ICE-grace-timeout closeConsumerTransport use this
	// production policy before runtime.captureRecoverySnapshot calls integration.
	clearRemoteMediaForTransportFailure(ports);
	expect(f.integration.captureWatchedRemoteStreams()).toEqual(watched);
	expect(f.slot()?.producerPresent).toBe(false);
	expect(f.locals[0]?.closeCount).toBe(1);
	expect(f.commands).toHaveLength(commandCount);
	// Terminal runtime cleanup always passes false, even after failure has
	// already removed the transport reference. A later session must start empty.
	clearRemoteMediaForTransport(ports, { preserveIntent: false });
	expect(f.integration.captureWatchedRemoteStreams()).toEqual({ remoteUserStreams: {}, externalStreams: {} });
	expect(f.store.getSnapshot().size).toBe(0);
	f.controller.replaceTransport({ id: 'later-session' });
	f.store.setCommandRunner((command) => f.commands.push(command));
	expect(f.commands).toHaveLength(commandCount);
});

test('consume started over a live consumer closes it inside the start without cancelling the new operation', async () => {
	const f = fixture();
	f.present();
	f.watch();
	await flush();
	f.resolveAllocation();
	await flush();
	f.resolveResume();
	await flush();
	expect(f.slot()?.consumerId).toBe('c-p1');
	const commandCount = f.commands.length;
	// The existing-producer sweep consumes directly, with no producer id, over a slot the ledger still holds.
	void f.controller.consume({ remoteId: 7, kind: StreamKind.VIDEO, rtpCapabilities: {} });
	const start = f.startBoundaries.at(-1);
	if (!start) throw new Error('restart did not start');
	expect(start.consumerId).toBe('c-p1');
	expect(start.commandsAfter).toBe(start.commandsBefore + 1);
	expect(f.commands.slice(commandCount)).toEqual([
		{
			type: 'closeConsumer',
			key: getPendingStreamKey(7, StreamKind.VIDEO),
			generation: undefined,
			remoteId: 7,
			kind: StreamKind.VIDEO,
			consumerId: 'c-p1',
			reason: 'consumer_replaced',
		},
	]);
	expect(f.closeBoundaries.at(-1)).toEqual({ consumerId: 'c-p1', slotConsumerId: undefined });
	expect(start.signal.aborted).toBe(false);
	expect(f.locals[0]?.closeCount).toBe(1);
	expect(f.closes).toEqual(['c-p1']);
	await flush();
	expect(f.allocations).toHaveLength(2);
	f.allocations[1]?.result.resolve({
		producerId: 'p1',
		consumerId: 'c-restart',
		consumerKind: StreamKind.VIDEO,
		consumerRtpParameters: {},
	});
	await flush();
	f.resumes.find((resume) => resume.id === 'c-restart')?.result.resolve();
	await flush();
	expect(f.slot()?.status).toBe('consumed');
	expect(f.slot()?.consumerId).toBe('c-restart');
	expect(f.commands).toHaveLength(commandCount + 1);
	expect(f.closes).toEqual(['c-p1']);
	expect(f.attached).toEqual(['c-p1', 'c-restart']);
	expect(f.detached).toEqual(['c-p1']);
	expect(f.locals.map((local) => local.closeCount)).toEqual([1, 0]);
});
