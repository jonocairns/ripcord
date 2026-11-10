import { ServerEvents, type StreamKind } from '@sharkord/shared';
import { observable } from '@trpc/server/observable';
import { VoiceRuntime } from '../../runtimes/voice';
import type { Events } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

type TVoiceProducerEvent = {
	channelId: number;
	remoteId: number;
	kind: StreamKind;
	producerId?: string;
	recoverable?: boolean;
};

type TVoiceActivityEvent = {
	channelId: number;
	userId: number;
	isSpeaking: boolean;
};

const isUserStillJoinedToVoiceChannel = (userId: number, channelId: number): boolean => {
	const runtime = VoiceRuntime.findById(channelId);

	return runtime?.getUser(userId) !== undefined;
};

// these events are sent to channel viewers and the subject user (for UI population in the sidebar)
const onUserJoinVoiceRoute = protectedProcedure.subscription(async ({ ctx }) => {
	return ctx.pubsub.subscribeFor(ctx.user.id, ServerEvents.USER_JOIN_VOICE);
});

const onUserLeaveVoiceRoute = protectedProcedure.subscription(async ({ ctx }) => {
	return ctx.pubsub.subscribeFor(ctx.user.id, ServerEvents.USER_LEAVE_VOICE);
});

const onUserUpdateVoiceStateRoute = protectedProcedure.subscription(async ({ ctx }) => {
	return observable<Events[ServerEvents.USER_VOICE_STATE_UPDATE]>((observer) => {
		// A restore batched with this subscription can reconcile state before
		// tRPC attaches the observable. Subscribe first, then replay own state so
		// faster permission checks cannot lose the reconnect mute confirmation.
		const subscription = ctx.pubsub.subscribeFor(ctx.user.id, ServerEvents.USER_VOICE_STATE_UPDATE).subscribe(observer);
		const runtime = VoiceRuntime.findRuntimeByUserId(ctx.user.id);
		if (runtime) {
			observer.next({ channelId: runtime.id, userId: ctx.user.id, state: runtime.getUserState(ctx.user.id) });
		}
		return () => subscription.unsubscribe();
	});
});

const onVoiceSessionReplacedRoute = protectedProcedure.subscription(async ({ ctx }) => {
	return ctx.pubsub.subscribeFor(ctx.user.id, ServerEvents.VOICE_SESSION_REPLACED);
});

// these events are sent to channel viewers and the subject user (for external stream UI in the sidebar)
const onVoiceAddExternalStreamRoute = protectedProcedure.subscription(async ({ ctx }) => {
	return ctx.pubsub.subscribeFor(ctx.user.id, ServerEvents.VOICE_ADD_EXTERNAL_STREAM);
});

const onVoiceUpdateExternalStreamRoute = protectedProcedure.subscription(async ({ ctx }) => {
	return ctx.pubsub.subscribeFor(ctx.user.id, ServerEvents.VOICE_UPDATE_EXTERNAL_STREAM);
});

const onVoiceRemoveExternalStreamRoute = protectedProcedure.subscription(async ({ ctx }) => {
	return ctx.pubsub.subscribeFor(ctx.user.id, ServerEvents.VOICE_REMOVE_EXTERNAL_STREAM);
});

// these events are channel-scoped (only sent to users in the same voice channel)
// they relate to actual media streaming, not UI state
const onVoiceNewProducerRoute = protectedProcedure.subscription(async ({ ctx }) => {
	const channelId = ctx.currentVoiceChannelId;

	if (!channelId) {
		return observable<TVoiceProducerEvent>(() => () => {});
	}

	return ctx.pubsub.subscribeForChannel(channelId, ServerEvents.VOICE_NEW_PRODUCER, () =>
		isUserStillJoinedToVoiceChannel(ctx.user.id, channelId),
	);
});

const onVoiceProducerClosedRoute = protectedProcedure.subscription(async ({ ctx }) => {
	const channelId = ctx.currentVoiceChannelId;

	if (!channelId) {
		return observable<TVoiceProducerEvent>(() => () => {});
	}

	return ctx.pubsub.subscribeForChannel(channelId, ServerEvents.VOICE_PRODUCER_CLOSED, () =>
		isUserStillJoinedToVoiceChannel(ctx.user.id, channelId),
	);
});

const onVoiceActivityUpdateRoute = protectedProcedure.subscription(async ({ ctx }) => {
	const channelId = ctx.currentVoiceChannelId;

	if (!channelId) {
		return observable<TVoiceActivityEvent>(() => () => {});
	}

	return observable<TVoiceActivityEvent>((observer) => {
		// Subscribe before snapshotting so a speaking-state change that happens
		// between the two steps is delivered, not dropped.
		const subscription = ctx.pubsub
			.subscribeForChannel(channelId, ServerEvents.VOICE_ACTIVITY_UPDATE, () =>
				isUserStillJoinedToVoiceChannel(ctx.user.id, channelId),
			)
			.subscribe({
				next: (event) => {
					observer.next(event);
				},
			});

		const runtime = VoiceRuntime.findById(channelId);

		runtime?.getSpeakingUserIds().forEach((userId) => {
			observer.next({
				channelId,
				userId,
				isSpeaking: true,
			});
		});

		return () => {
			subscription.unsubscribe();
		};
	});
});

const onVoiceStreamWatcherActivityRoute = protectedProcedure.subscription(async ({ ctx }) => {
	return ctx.pubsub.subscribeFor(ctx.user.id, ServerEvents.VOICE_STREAM_WATCHER_ACTIVITY);
});

const onVoiceTransportFailedRoute = protectedProcedure.subscription(async ({ ctx }) => {
	return ctx.pubsub.subscribeFor(ctx.user.id, ServerEvents.VOICE_TRANSPORT_FAILED);
});

export {
	onUserJoinVoiceRoute,
	onUserLeaveVoiceRoute,
	onUserUpdateVoiceStateRoute,
	onVoiceActivityUpdateRoute,
	onVoiceAddExternalStreamRoute,
	onVoiceNewProducerRoute,
	onVoiceProducerClosedRoute,
	onVoiceRemoveExternalStreamRoute,
	onVoiceSessionReplacedRoute,
	onVoiceStreamWatcherActivityRoute,
	onVoiceTransportFailedRoute,
	onVoiceUpdateExternalStreamRoute,
};
