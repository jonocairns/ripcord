import { afterEach, expect, test } from 'bun:test';
import { ChannelPermission, ServerEvents } from '@sharkord/shared';
import { initTest } from '../../__tests__/helpers';
import { VoiceRuntime } from '../../runtimes/voice';
import { type Events, pubsub } from '../../utils/pubsub';
import { publishVoiceSidebarEvent } from '../../utils/voice-sidebar-events';

const subscriptions: { unsubscribe(): void }[] = [];
const state = { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false };
const observe = <T extends keyof Events>(userId: number, topic: T) => {
	const events: Events[T][] = [];
	subscriptions.push(pubsub.subscribeFor(userId, topic).subscribe({ next: (event) => events.push(event) }));
	return events;
};
const setup = async () => {
	const runtime = new VoiceRuntime(2);
	await runtime.init();
	const { caller: owner } = await initTest(1);
	const { caller: member } = await initTest(2);
	return { runtime, owner, member };
};
afterEach(async () => {
	for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
	const runtime = VoiceRuntime.findById(2);
	if (runtime) {
		for (const user of [...runtime.getState().users]) runtime.removeUser(user.userId);
		await runtime.destroy();
	}
});

test('join snapshots omit hidden voice, streams and text read states, retaining public channels', async () => {
	const { owner } = await setup();
	await owner.channels.update({ channelId: 2, private: true });
	await owner.voice.join({ channelId: 2, state });
	await owner.messages.send({ channelId: 1, content: 'private text', files: [] });
	await owner.channels.update({ channelId: 1, private: true });
	const hidden = (await initTest(2)).initialData;
	const visible = (await initTest(1)).initialData;
	expect(hidden.voiceMap).not.toHaveProperty('2');
	expect(hidden.externalStreamsMap).not.toHaveProperty('2');
	expect(hidden.readStates).not.toHaveProperty('1');
	expect(visible.voiceMap).toHaveProperty('2');
	expect(visible.externalStreamsMap).toHaveProperty('2');
	expect(visible.readStates).toHaveProperty('1');
	await owner.channels.update({ channelId: 2, private: false });
	for (const userId of [1, 2]) {
		const result = (await initTest(userId)).initialData;
		expect(result.voiceMap).toHaveProperty('2');
		expect(result.externalStreamsMap).toHaveProperty('2');
	}
});

test('live joins and state updates reach viewers', async () => {
	const { owner } = await setup();
	await owner.channels.update({ channelId: 2, private: true });
	const hiddenJoins = observe(2, ServerEvents.USER_JOIN_VOICE);
	const hiddenStates = observe(2, ServerEvents.USER_VOICE_STATE_UPDATE);
	const joins = observe(1, ServerEvents.USER_JOIN_VOICE);
	const states = observe(1, ServerEvents.USER_VOICE_STATE_UPDATE);
	await owner.voice.join({ channelId: 2, state });
	await owner.voice.updateState({ micMuted: true });
	expect(joins).toHaveLength(1);
	expect(states).toHaveLength(1);
	expect(hiddenJoins).toHaveLength(0);
	expect(hiddenStates).toHaveLength(0);
	await owner.channels.update({ channelId: 2, private: false });
	hiddenJoins.length = 0;
	await owner.voice.leave();
	await owner.voice.join({ channelId: 2, state });
	await owner.voice.updateState({ micMuted: true });
	expect(hiddenJoins).toHaveLength(1);
	expect(hiddenStates).toHaveLength(1);
});

test('evicted subjects receive their own leave after access is revoked', async () => {
	const { owner, member } = await setup();
	await owner.channels.updatePermissions({
		channelId: 2,
		userId: 2,
		permissions: [ChannelPermission.VIEW_CHANNEL, ChannelPermission.JOIN],
	});
	await owner.channels.update({ channelId: 2, private: true });
	await member.voice.join({ channelId: 2, state });
	const leaves = observe(2, ServerEvents.USER_LEAVE_VOICE);
	await owner.channels.deletePermissions({ channelId: 2, userId: 2 });
	expect(leaves).toContainEqual(expect.objectContaining({ channelId: 2, userId: 2 }));
});

test('visibility gain replays members silently and loss withdraws them before channel deletion', async () => {
	const { owner } = await setup();
	await owner.channels.update({ channelId: 2, private: true });
	await owner.voice.join({ channelId: 2, state });
	const joins = observe(2, ServerEvents.USER_JOIN_VOICE);
	const leaves = observe(2, ServerEvents.USER_LEAVE_VOICE);
	const atDelete: number[] = [];
	subscriptions.push(
		pubsub.subscribeFor(2, ServerEvents.CHANNEL_DELETE).subscribe({ next: () => atDelete.push(leaves.length) }),
	);
	await owner.channels.updatePermissions({ channelId: 2, userId: 2, permissions: [ChannelPermission.VIEW_CHANNEL] });
	expect(joins).toEqual([expect.objectContaining({ channelId: 2, userId: 1, reconnecting: true })]);
	await owner.channels.deletePermissions({ channelId: 2, userId: 2 });
	expect(leaves).toEqual([{ channelId: 2, userId: 1, reconnecting: true }]);
	expect(atDelete).toEqual([1]);
});

test('turning a public channel private withdraws its members', async () => {
	const { owner } = await setup();
	await owner.voice.join({ channelId: 2, state });
	const leaves = observe(2, ServerEvents.USER_LEAVE_VOICE);
	await owner.channels.update({ channelId: 2, private: true });
	expect(leaves).toEqual([{ channelId: 2, userId: 1, reconnecting: true }]);
});

test('saving a channel does not replay joins to current members', async () => {
	const { owner, member } = await setup();
	await owner.voice.join({ channelId: 2, state });
	await member.voice.join({ channelId: 2, state });
	const ownerJoins = observe(1, ServerEvents.USER_JOIN_VOICE);
	const memberJoins = observe(2, ServerEvents.USER_JOIN_VOICE);
	await owner.channels.update({ channelId: 2, private: false });
	expect(ownerJoins).toEqual([]);
	expect(memberJoins).toEqual([]);
});

test('all sidebar topics target viewers synchronously without duplicating the subject', async () => {
	const { owner, member } = await setup();
	await owner.channels.update({ channelId: 2, private: true });
	const stream = {
		title: 'Private plugin title',
		key: 'private',
		pluginId: 'test',
		tracks: { audio: false, video: false },
	};
	const topics = [
		ServerEvents.USER_JOIN_VOICE,
		ServerEvents.USER_LEAVE_VOICE,
		ServerEvents.USER_VOICE_STATE_UPDATE,
		ServerEvents.VOICE_ADD_EXTERNAL_STREAM,
		ServerEvents.VOICE_UPDATE_EXTERNAL_STREAM,
		ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM,
	] as const;
	const routeReceived: string[] = [];
	const routeHidden: string[] = [];
	for (const [caller, events] of [
		[owner, routeReceived],
		[member, routeHidden],
	] as const) {
		const routes = [
			caller.voice.onJoin,
			caller.voice.onLeave,
			caller.voice.onUpdateState,
			caller.voice.onAddExternalStream,
			caller.voice.onUpdateExternalStream,
			caller.voice.onRemoveExternalStream,
		];
		for (const [index, route] of routes.entries()) {
			subscriptions.push((await route()).subscribe({ next: () => events.push(String(index)) }));
		}
	}
	const received: string[] = [];
	const hidden: string[] = [];
	for (const topic of topics) {
		subscriptions.push(pubsub.subscribeFor(1, topic).subscribe({ next: () => received.push(topic) }));
		subscriptions.push(pubsub.subscribeFor(2, topic).subscribe({ next: () => hidden.push(topic) }));
	}
	const publish = () => {
		publishVoiceSidebarEvent(ServerEvents.USER_JOIN_VOICE, { channelId: 2, userId: 1, state });
		publishVoiceSidebarEvent(ServerEvents.USER_LEAVE_VOICE, { channelId: 2, userId: 1 });
		publishVoiceSidebarEvent(ServerEvents.USER_VOICE_STATE_UPDATE, { channelId: 2, userId: 1, state });
		publishVoiceSidebarEvent(ServerEvents.VOICE_ADD_EXTERNAL_STREAM, { channelId: 2, streamId: 1, stream });
		publishVoiceSidebarEvent(ServerEvents.VOICE_UPDATE_EXTERNAL_STREAM, { channelId: 2, streamId: 1, stream });
		publishVoiceSidebarEvent(ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM, { channelId: 2, streamId: 1 });
	};
	publish();
	expect(received).toEqual([...topics]);
	expect(hidden).toEqual([]);
	expect(routeReceived).toEqual(['0', '1', '2', '3', '4', '5']);
	expect(routeHidden).toEqual([]);
	await owner.channels.update({ channelId: 2, private: false });
	received.length = 0;
	hidden.length = 0;
	publish();
	expect(received).toEqual([...topics]);
	expect(hidden).toEqual([...topics]);
	expect(routeHidden).toEqual(['0', '1', '2', '3', '4', '5']);
});

test('visibility changes replay and withdraw plugin streams', async () => {
	const { runtime, owner } = await setup();
	await owner.channels.update({ channelId: 2, private: true });
	const streamId = runtime.createExternalStream({
		title: 'Private title',
		key: 'private',
		pluginId: 'test',
		producers: {},
	});
	const adds = observe(2, ServerEvents.VOICE_ADD_EXTERNAL_STREAM);
	const removes = observe(2, ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM);
	await owner.channels.updatePermissions({ channelId: 2, userId: 2, permissions: [ChannelPermission.VIEW_CHANNEL] });
	const stream = runtime.getState().externalStreams[streamId];
	if (!stream) throw new Error('Stream missing');
	expect(adds).toEqual([{ channelId: 2, streamId, stream }]);
	await owner.channels.deletePermissions({ channelId: 2, userId: 2 });
	expect(removes).toEqual([{ channelId: 2, streamId }]);
});

test('voice state subscription replays a restore that reconciled before listener attachment', async () => {
	const { runtime, owner } = await setup();
	await owner.voice.join({ channelId: 2, state });
	const stream = await owner.voice.onUpdateState();
	// Faster permission checks let a batched restore reconcile before tRPC
	// subscribes to the returned observable. Its one-shot event is already gone.
	runtime.reconcileVoiceRestoreState(1, { micMuted: true, soundMuted: false });
	publishVoiceSidebarEvent(ServerEvents.USER_VOICE_STATE_UPDATE, {
		channelId: 2,
		userId: 1,
		state: runtime.getUserState(1),
	});
	const events: Events[ServerEvents.USER_VOICE_STATE_UPDATE][] = [];
	subscriptions.push(stream.subscribe({ next: (event) => events.push(event) }));
	expect(events).toEqual([{ channelId: 2, userId: 1, state: { ...state, micMuted: true } }]);
	await owner.voice.updateState({ micMuted: false });
	expect(events.map((event) => event.state.micMuted)).toEqual([true, false]);
});
