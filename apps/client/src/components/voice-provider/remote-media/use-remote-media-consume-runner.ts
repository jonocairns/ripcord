import type { RtpCapabilities } from 'mediasoup-client/types';
import { useEffect } from 'react';
import { useLatestRef } from '@/hooks/use-latest-ref';
import {
	createRemoteMediaCommandRunner,
	type TCloseRemoteConsumer,
	type TConsumeRemoteMedia,
} from './remote-media-command-runner';
import type { TRemoteMediaLedgerStore } from './remote-media-ledger-store';
import type { TExternalStreamTrackPresence } from './use-pending-streams';

export const useRemoteMediaConsumeRunner = ({
	currentVoiceChannelId,
	rtpCapabilities,
	ledgerStore,
	consume,
	closeConsumer,
	getExternalStreamTrackPresence,
}: {
	currentVoiceChannelId: number | undefined;
	rtpCapabilities: RtpCapabilities | null;
	ledgerStore: TRemoteMediaLedgerStore;
	consume: TConsumeRemoteMedia;
	closeConsumer: TCloseRemoteConsumer;
	getExternalStreamTrackPresence: () => TExternalStreamTrackPresence;
}) => {
	const inputs = useLatestRef({ consume, closeConsumer, getExternalStreamTrackPresence });
	useEffect(() => {
		if (currentVoiceChannelId === undefined || !rtpCapabilities) {
			ledgerStore.setCommandRunner(undefined);
		} else {
			ledgerStore.setCommandRunner(
				createRemoteMediaCommandRunner({
					getSnapshot: ledgerStore.getSnapshot,
					getRtpCapabilities: () => rtpCapabilities,
					getExternalStreamTrackPresence: () => inputs.current.getExternalStreamTrackPresence(),
					consume: (...args) => inputs.current.consume(...args),
					closeConsumer: (...args) => inputs.current.closeConsumer(...args),
				}),
			);
		}
		return () => ledgerStore.setCommandRunner(undefined);
	}, [currentVoiceChannelId, rtpCapabilities, ledgerStore]);
};
