import type { TExternalStream } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useEffect, useRef } from 'react';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { getRemoteMediaRepairDelayMs } from './remote-media-repair-policy';
import {
	isRemoteMediaRepairScheduleCommandCurrent,
	remoteMediaRepairIdentityKey,
	remoteMediaSubscriptionsToRepairScheduleCommands,
	type TRemoteMediaRepairIdentity,
	type TRemoteMediaRepairScheduleCommand,
	type TRemoteMediaSubscriptions,
} from './remote-media-subscriptions';
import type { TExternalStreamTrackPresence, TPendingStream } from './use-pending-streams';

type TRepairRemoteProducer = (
	identity: TRemoteMediaRepairIdentity,
	rtpCapabilities: RtpCapabilities,
	externalStreamTracks?: TExternalStreamTrackPresence,
) => Promise<unknown>;

type TUseRemoteMediaRepairRunnerInput = {
	currentVoiceChannelId: number | undefined;
	rtpCapabilities: RtpCapabilities | null;
	remoteMediaSubscriptions: TRemoteMediaSubscriptions;
	pendingStreams: Map<string, TPendingStream>;
	currentChannelExternalStreams: Record<number, TExternalStream>;
	markRepairAttemptStarted: (
		command: TRemoteMediaRepairScheduleCommand,
		currentVoiceChannelId: number | undefined,
		currentExternalStreams: Record<number, unknown>,
	) => void;
	repairRemoteProducer: TRepairRemoteProducer;
	getExternalStreamTrackPresence: () => TExternalStreamTrackPresence;
};

export const useRemoteMediaRepairRunner = ({
	currentVoiceChannelId,
	rtpCapabilities,
	remoteMediaSubscriptions,
	pendingStreams,
	currentChannelExternalStreams,
	markRepairAttemptStarted,
	repairRemoteProducer,
	getExternalStreamTrackPresence,
}: TUseRemoteMediaRepairRunnerInput) => {
	const remoteMediaSubscriptionsRef = useLatestRef(remoteMediaSubscriptions);
	const currentVoiceChannelIdRef = useLatestRef(currentVoiceChannelId);
	const currentChannelExternalStreamsRef = useLatestRef(currentChannelExternalStreams);
	const loggedExhaustedIdentitiesRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		if (currentVoiceChannelId === undefined || !rtpCapabilities || pendingStreams.size === 0) {
			loggedExhaustedIdentitiesRef.current.clear();
			return;
		}

		const commands = remoteMediaSubscriptionsToRepairScheduleCommands(
			currentVoiceChannelId,
			remoteMediaSubscriptionsRef.current,
			pendingStreams,
			currentChannelExternalStreams,
		);
		const currentIdentityKeys = new Set(commands.map((command) => remoteMediaRepairIdentityKey(command.identity)));

		loggedExhaustedIdentitiesRef.current.forEach((identityKey) => {
			if (!currentIdentityKeys.has(identityKey)) {
				loggedExhaustedIdentitiesRef.current.delete(identityKey);
			}
		});

		const repairTimeouts: ReturnType<typeof setTimeout>[] = [];
		const firstRepairIntervalMs = getRemoteMediaRepairDelayMs(0) ?? 0;

		commands.forEach((command) => {
			const repairIdentityKey = remoteMediaRepairIdentityKey(command.identity);
			const repairIntervalMs = getRemoteMediaRepairDelayMs(command.completedAttempts);

			if (repairIntervalMs === undefined) {
				if (!loggedExhaustedIdentitiesRef.current.has(repairIdentityKey)) {
					loggedExhaustedIdentitiesRef.current.add(repairIdentityKey);
					logVoice('Remote media repair budget exhausted', {
						channelId: command.identity.channelId,
						remoteId: command.identity.remoteId,
						kind: command.identity.kind,
						producerId: command.identity.producerId,
						completedAttempts: command.completedAttempts,
					});
				}
				return;
			}

			const repairDelayMs = Math.max(0, command.retryAt + repairIntervalMs - firstRepairIntervalMs - Date.now());
			const repairTimeout = setTimeout(() => {
				const currentSubscriptions = remoteMediaSubscriptionsRef.current;
				const currentExternalStreams = currentChannelExternalStreamsRef.current;

				if (
					!isRemoteMediaRepairScheduleCommandCurrent(
						currentSubscriptions,
						command,
						currentVoiceChannelIdRef.current,
						currentExternalStreams,
					)
				) {
					return;
				}

				markRepairAttemptStarted(command, currentVoiceChannelIdRef.current, currentExternalStreams);

				logVoice('Repairing stale pending voice stream', {
					channelId: command.identity.channelId,
					remoteId: command.identity.remoteId,
					kind: command.identity.kind,
					producerId: command.identity.producerId,
					attempt: command.completedAttempts + 1,
				});

				void repairRemoteProducer(command.identity, rtpCapabilities, getExternalStreamTrackPresence()).catch(
					(error) => {
						logVoice('Failed to repair stale pending voice stream', {
							error,
							channelId: command.identity.channelId,
							remoteId: command.identity.remoteId,
							kind: command.identity.kind,
							producerId: command.identity.producerId,
						});
					},
				);
			}, repairDelayMs);

			repairTimeouts.push(repairTimeout);
		});

		return () => {
			repairTimeouts.forEach((repairTimeout) => clearTimeout(repairTimeout));
		};
	}, [
		currentChannelExternalStreams,
		currentVoiceChannelId,
		getExternalStreamTrackPresence,
		markRepairAttemptStarted,
		pendingStreams,
		repairRemoteProducer,
		rtpCapabilities,
	]);
};
