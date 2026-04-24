import { useCallback, useEffect, useRef, useState } from 'react';
import { PinnedCardType, type TPinnedCard } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import { setSelectedChannelId } from '@/features/server/channels/actions';
import { selectedChannelIdSelector } from '@/features/server/channels/selectors';
import { useServerStore } from '@/features/server/slice';
import { setPinnedCard } from '@/features/server/voice/actions';
import { pinnedCardSelector } from '@/features/server/voice/selectors';

type TScreenShareStageParams = {
	ownUserId: number | undefined;
	currentVoiceChannelId: number | undefined;
};

type TScreenShareTransition = {
	isCurrent: () => boolean;
	invalidate: () => void;
};

// Restore snapshot is only populated while a start transition is in flight;
// `idle` means there is nothing to restore and calls to `restore()` are no-ops.
type TScreenShareRestoreState =
	| { kind: 'idle' }
	| {
			kind: 'active';
			previousPinnedCard: TPinnedCard | undefined;
			previousSelectedChannelId: number | undefined;
			autoSelectedVoiceChannel: boolean;
	  };

type TScreenShareStageValue = {
	isStarting: boolean;
	newTransition: () => TScreenShareTransition;
	beginStart: () => void;
	finishStart: () => void;
	restore: () => void;
};

const useScreenShareStage = ({ ownUserId, currentVoiceChannelId }: TScreenShareStageParams): TScreenShareStageValue => {
	const [isStarting, setIsStarting] = useState(false);
	const transitionIdRef = useRef(0);
	const restoreStateRef = useRef<TScreenShareRestoreState>({ kind: 'idle' });
	const currentVoiceChannelIdRef = useRef(currentVoiceChannelId);

	useEffect(() => {
		currentVoiceChannelIdRef.current = currentVoiceChannelId;
	}, [currentVoiceChannelId]);

	const newTransition = useCallback((): TScreenShareTransition => {
		const id = transitionIdRef.current + 1;
		transitionIdRef.current = id;

		return {
			isCurrent: () => transitionIdRef.current === id,
			invalidate: () => {
				if (transitionIdRef.current === id) {
					transitionIdRef.current += 1;
				}
			},
		};
	}, []);

	const beginStart = useCallback(() => {
		setIsStarting(true);

		const channelId = currentVoiceChannelIdRef.current;

		if (ownUserId === undefined || channelId === undefined) {
			restoreStateRef.current = { kind: 'idle' };
			return;
		}

		const state = useServerStore.getState();
		const selectedChannelId = selectedChannelIdSelector(state);

		restoreStateRef.current = {
			kind: 'active',
			previousPinnedCard: pinnedCardSelector(state),
			previousSelectedChannelId: selectedChannelId,
			autoSelectedVoiceChannel: selectedChannelId !== channelId,
		};

		setSelectedChannelId(channelId);
		setPinnedCard({
			id: `screen-share-${ownUserId}`,
			type: PinnedCardType.SCREEN_SHARE,
			userId: ownUserId,
		});
	}, [ownUserId]);

	const finishStart = useCallback(() => {
		setIsStarting(false);
	}, []);

	const restore = useCallback(() => {
		setIsStarting(false);

		const restoreState = restoreStateRef.current;
		restoreStateRef.current = { kind: 'idle' };

		if (restoreState.kind !== 'active' || ownUserId === undefined) {
			return;
		}

		const state = useServerStore.getState();
		const currentPinnedCard = pinnedCardSelector(state);

		if (currentPinnedCard?.id === `screen-share-${ownUserId}`) {
			setPinnedCard(restoreState.previousPinnedCard);
		}

		if (restoreState.autoSelectedVoiceChannel) {
			const channelId = currentVoiceChannelIdRef.current;
			const currentSelectedChannelId = selectedChannelIdSelector(state);

			if (channelId !== undefined && currentSelectedChannelId === channelId) {
				setSelectedChannelId(restoreState.previousSelectedChannelId);
			}
		}
	}, [ownUserId]);

	return {
		isStarting,
		newTransition,
		beginStart,
		finishStart,
		restore,
	};
};

export type { TScreenShareStageValue, TScreenShareTransition };
export { useScreenShareStage };
