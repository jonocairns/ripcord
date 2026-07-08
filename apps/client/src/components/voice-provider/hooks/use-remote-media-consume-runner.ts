import type { StreamKind } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useEffect } from 'react';
import type { TRemoteMediaCommand, TStreamsToConsumeCommand } from './remote-media-subscriptions';

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
	clearCommands: (commands: TRemoteMediaCommand[]) => void;
	consume: TConsumeRemoteMedia;
	closeConsumer: TCloseRemoteConsumer;
};

export const useRemoteMediaConsumeRunner = ({
	currentVoiceChannelId,
	rtpCapabilities,
	commands,
	clearCommands,
	consume,
	closeConsumer,
}: TUseRemoteMediaConsumeRunnerInput) => {
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

		runnableCommands.forEach((command) => {
			if (command.type === 'consume') {
				const consumeCommand: TStreamsToConsumeCommand = command;
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
	}, [clearCommands, closeConsumer, commands, consume, currentVoiceChannelId, rtpCapabilities]);
};
