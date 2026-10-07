import type { StreamKind } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useEffect } from 'react';
import { useLatestRef } from '@/hooks/use-latest-ref';
import {
	isConsumeCommandRunnable,
	type TRemoteMediaCommand,
	type TRemoteMediaSubscriptions,
	type TStreamsToConsumeCommand,
} from './remote-media-subscriptions';
import type { TExternalStreamTrackPresence } from './use-pending-streams';

type TConsumeRemoteMedia = (
	remoteId: number,
	kind: StreamKind,
	rtpCapabilities: RtpCapabilities,
	expectedProducerId?: string,
	options?: {
		isManualRetry?: boolean;
		restartExisting?: boolean;
	},
) => Promise<unknown>;

type TCloseRemoteConsumer = (
	remoteId: number,
	kind: StreamKind,
	consumerId?: string,
	generation?: number,
) => Promise<unknown>;

type TUseRemoteMediaConsumeRunnerInput = {
	currentVoiceChannelId: number | undefined;
	rtpCapabilities: RtpCapabilities | null;
	commands: TRemoteMediaCommand[];
	remoteMediaSubscriptions: TRemoteMediaSubscriptions;
	clearCommands: (commands: TRemoteMediaCommand[]) => void;
	consume: TConsumeRemoteMedia;
	closeConsumer: TCloseRemoteConsumer;
	getExternalStreamTrackPresence: () => TExternalStreamTrackPresence;
};

export const useRemoteMediaConsumeRunner = ({
	currentVoiceChannelId,
	rtpCapabilities,
	commands,
	remoteMediaSubscriptions,
	clearCommands,
	consume,
	closeConsumer,
	getExternalStreamTrackPresence,
}: TUseRemoteMediaConsumeRunnerInput) => {
	// Read against the freshest ledger at drain time without re-running the drain
	// on every subscription change; commands and subscriptions update atomically,
	// so the command batch and this snapshot stay consistent.
	const remoteMediaSubscriptionsRef = useLatestRef(remoteMediaSubscriptions);

	useEffect(() => {
		if (currentVoiceChannelId === undefined) {
			return;
		}

		const currentRtpCapabilities = rtpCapabilities;

		if (!currentRtpCapabilities) {
			return;
		}

		const runnableCommands = commands;

		if (runnableCommands.length === 0) {
			return;
		}

		clearCommands(runnableCommands);

		const currentSubscriptions = remoteMediaSubscriptionsRef.current;
		const externalStreamTracks = getExternalStreamTrackPresence();

		runnableCommands.forEach((command) => {
			if (command.type === 'consume') {
				const consumeCommand: TStreamsToConsumeCommand = command;

				// A queued consume can outlive its intent (e.g. the user stopped
				// watching while rtpCapabilities was unavailable). Running it would
				// re-request the watch and resurrect stopped media, so skip commands
				// whose slot is no longer consume-eligible in the live ledger.
				if (!isConsumeCommandRunnable(currentSubscriptions, consumeCommand, externalStreamTracks)) {
					return;
				}

				void consume(consumeCommand.remoteId, consumeCommand.kind, currentRtpCapabilities, consumeCommand.producerId, {
					isManualRetry: consumeCommand.isManualRetry,
					restartExisting: consumeCommand.isManualRetry,
				});
				return;
			}

			if (command.type === 'closeConsumer') {
				void closeConsumer(command.remoteId, command.kind, command.consumerId, command.generation);
			}
		});
	}, [
		clearCommands,
		closeConsumer,
		commands,
		consume,
		currentVoiceChannelId,
		getExternalStreamTrackPresence,
		rtpCapabilities,
	]);
};
