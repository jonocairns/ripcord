import { beforeEach, expect, it, mock } from 'bun:test';
import { mountOwnMicGateSync } from '@/components/voice-provider/microphone/own-mic-gate-sync';
import type { TInitialServerData } from '../../slice';
import { useServerStore } from '../../slice';
import { captureVoiceReconnectIntentForCurrentSession, getValidPendingVoiceReconnect } from '../reconnect-coordinator';
import {
	ownMicWantedSelector,
	ownTransmittingSelector,
	ownVoiceSessionPayloadSelector,
	ownVoiceStateSelector,
} from '../selectors';
import { resetVoiceSessionState } from '../voice-session-store';

const row = (micMuted = false, soundMuted = false, video = false) => ({
	micMuted,
	soundMuted,
	webcamEnabled: video,
	sharingScreen: video,
});
const initial = (voiceMap: TInitialServerData['voiceMap']): TInitialServerData => ({
	serverId: 'server',
	ownUserId: 42,
	voiceMap,
	mustChangePassword: false,
	categories: [],
	channels: [],
	users: [],
	roles: [],
	emojis: [],
	externalStreamsMap: {},
	channelPermissions: {},
	readStates: {},
});
beforeEach(() => {
	useServerStore.getState().resetState();
	useServerStore.getState().setOwnVoiceIntent({ micMuted: false, soundMuted: false });
	resetVoiceSessionState();
});
for (const micMuted of [false, true])
	for (const soundMuted of [false, true])
		for (const ingress of ['initial', 'add', 'update', 'reconcile'] as const)
			for (const window of ['none', 'expired', 'active'])
				for (const talk of [false, true]) {
					it(`preserves local audio: ${micMuted}/${soundMuted} ${ingress} ${window} talk ${talk}`, () => {
						const intent = { micMuted, soundMuted };
						useServerStore.setState({
							ownUserId: 42,
							currentVoiceChannelId: 7,
							ownVoiceIntent: intent,
							ownPushHold: { talk, mute: false },
							ownOptimisticStateExpiresAt:
								window === 'none' ? undefined : Date.now() + (window === 'active' ? 5000 : -1),
							voiceMap: { 7: { users: { 42: row(), 43: row() } } },
						});
						const before = useServerStore.getState();
						const shown = ownVoiceStateSelector(before);
						const wanted = ownMicWantedSelector(before);
						const gate = ownTransmittingSelector(before);
						const apply = mock(() => {});
						const unsubscribe = mountOwnMicGateSync({
							isTransmitting: () => ownTransmittingSelector(useServerStore.getState()),
							subscribe: useServerStore.subscribe,
							apply,
						});
						const incoming = row(!micMuted, !soundMuted, true);
						const store = useServerStore.getState();
						if (ingress === 'initial') store.setInitialData(initial({ 7: { users: { 42: incoming, 43: incoming } } }));
						if (ingress === 'add') {
							store.addUserToVoiceChannel({ channelId: 7, userId: 42, state: incoming });
							store.addUserToVoiceChannel({ channelId: 7, userId: 43, state: incoming });
						}
						if (ingress === 'update') {
							store.updateVoiceUserState({ channelId: 7, userId: 42, newState: incoming });
							store.updateVoiceUserState({ channelId: 7, userId: 43, newState: incoming });
						}
						if (ingress === 'reconcile')
							store.reconcileVoiceChannelUsers({
								channelId: 7,
								users: [
									{ userId: 42, state: incoming },
									{ userId: 43, state: incoming },
								],
							});
						const after = useServerStore.getState();
						expect(after.ownVoiceIntent).toBe(intent);
						expect(ownVoiceStateSelector(after)).toMatchObject({
							micMuted: shown.micMuted,
							soundMuted: shown.soundMuted,
						});
						expect(ownMicWantedSelector(after)).toBe(wanted);
						expect(ownTransmittingSelector(after)).toBe(gate);
						expect(apply).not.toHaveBeenCalled();
						expect(after.voiceMap[7]?.users[42]).toMatchObject({
							micMuted: shown.micMuted,
							soundMuted: shown.soundMuted,
						});
						expect(after.voiceMap[7]?.users[43]).toEqual(incoming);
						const preserved = window === 'active' && (ingress === 'update' || ingress === 'reconcile');
						expect(after.voiceMap[7]?.users[42]?.sharingScreen).toBe(!preserved);
						captureVoiceReconnectIntentForCurrentSession();
						expect(getValidPendingVoiceReconnect()).toMatchObject({ micMuted: micMuted || soundMuted, soundMuted });
						unsubscribe();
					});
				}
it('keeps mute across reset and stale or absent handshake rows, but resets transient holds', () => {
	useServerStore.getState().setOwnVoiceIntent({ micMuted: true });
	useServerStore.getState().setOwnPushHold({ talk: true, mute: false });
	useServerStore.getState().setOwnMicTestActive(true);
	useServerStore.getState().resetState();
	const handshakes: TInitialServerData['voiceMap'][] = [{ 7: { users: { 42: row() } } }, {}];
	for (const voiceMap of handshakes) {
		useServerStore.getState().setInitialData(initial(voiceMap));
		expect(ownVoiceSessionPayloadSelector(useServerStore.getState())).toEqual({ micMuted: true, soundMuted: false });
		expect(ownTransmittingSelector(useServerStore.getState())).toBe(false);
	}
	expect(useServerStore.getState().ownPushHold).toEqual({ talk: false, mute: false });
	expect(useServerStore.getState().ownMicTestActive).toBe(false);
});
for (const channel of [7, undefined])
	it(`does not guard another session or clear its watchers: current ${channel}`, () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: channel,
			ownOptimisticStateExpiresAt: Date.now() + 5000,
			screenShareWatchers: { 43: true },
			voiceMap: { 8: { users: { 42: row(false, false, true) } } },
		});
		const before = useServerStore.getState();
		before.updateVoiceUserState({ channelId: 8, userId: 42, newState: row(true, true) });
		const after = useServerStore.getState();
		expect(after.voiceMap[8]?.users[42]).toEqual(row(true, true));
		expect(after.ownOptimisticStateExpiresAt).toBe(before.ownOptimisticStateExpiresAt);
		expect(after.screenShareWatchers).toBe(before.screenShareWatchers);
	});
it('uses the incoming handshake user id and clears the video window', () => {
	useServerStore.setState({
		ownUserId: 99,
		currentVoiceChannelId: 7,
		ownVoiceIntent: { micMuted: true, soundMuted: false },
		ownOptimisticStateExpiresAt: Date.now() + 5000,
	});
	useServerStore.getState().setInitialData(initial({ 7: { users: { 42: row(false, false, true) } } }));
	expect(useServerStore.getState().voiceMap[7]?.users[42]).toEqual(row(true, false, true));
	expect(useServerStore.getState().ownOptimisticStateExpiresAt).toBeUndefined();
});
it('unchanged false screen-share state preserves watchers while a real stop clears them', () => {
	useServerStore.setState({
		ownUserId: 42,
		currentVoiceChannelId: 7,
		voiceMap: { 7: { users: { 42: row() } } },
		screenShareWatchers: { 43: true },
	});
	useServerStore.getState().updateVoiceUserState({ channelId: 7, userId: 42, newState: { sharingScreen: false } });
	expect(useServerStore.getState().screenShareWatchers).toEqual({ 43: true });
	useServerStore.getState().updateVoiceUserState({ channelId: 7, userId: 42, newState: { sharingScreen: true } });
	useServerStore.getState().updateVoiceUserState({ channelId: 7, userId: 42, newState: { sharingScreen: false } });
	expect(useServerStore.getState().screenShareWatchers).toEqual({});
});
