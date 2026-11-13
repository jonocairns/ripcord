import type { StreamKind, TCloseConsumerIntent, TStreamEventDetails } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import {
	isConsumeCommandRunnable,
	type TRemoteMediaCommand,
	type TRemoteMediaSubscriptions,
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
	reason?: TStreamEventDetails['reason'],
	intent?: TCloseConsumerIntent,
) => Promise<unknown>;

export const createRemoteMediaCommandRunner =
	(ports: {
		getSnapshot: () => TRemoteMediaSubscriptions;
		getRtpCapabilities: () => RtpCapabilities;
		getExternalStreamTrackPresence: () => TExternalStreamTrackPresence;
		consume: TConsumeRemoteMedia;
		closeConsumer: TCloseRemoteConsumer;
	}) =>
	(command: TRemoteMediaCommand): void => {
		if (command.type === 'consume') {
			if (!isConsumeCommandRunnable(ports.getSnapshot(), command, ports.getExternalStreamTrackPresence())) return;
			void ports.consume(command.remoteId, command.kind, ports.getRtpCapabilities(), command.producerId, {
				isManualRetry: command.isManualRetry,
				restartExisting: command.isManualRetry,
			});
		} else if (command.type === 'closeConsumer') {
			void ports.closeConsumer(command.remoteId, command.kind, command.consumerId, command.reason, command.intent);
		}
	};
export type { TCloseRemoteConsumer, TConsumeRemoteMedia };
