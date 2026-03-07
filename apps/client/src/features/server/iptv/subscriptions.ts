import { getTRPCClient } from '@/lib/trpc';
import { currentVoiceChannelIdSelector } from '../channels/selectors';
import { useServerStore } from '../slice';
import { setIptvStatus } from './actions';

const subscribeToIptv = () => {
  const trpc = getTRPCClient();
  let currentVoiceChannelId = currentVoiceChannelIdSelector(
    useServerStore.getState()
  );
  let onStatusChangeSub:
    | ReturnType<typeof trpc.iptv.onStatusChange.subscribe>
    | undefined;

  const subscribeToChannel = (channelId: number | undefined) => {
    onStatusChangeSub?.unsubscribe();
    onStatusChangeSub = undefined;

    if (channelId === undefined) {
      return;
    }

    onStatusChangeSub = trpc.iptv.onStatusChange.subscribe(
      { channelId },
      {
        onData: ({ channelId: nextChannelId, ...status }) => {
          setIptvStatus(nextChannelId, status);
        },
        onError: (error) => {
          console.error('iptv.onStatusChange subscription error:', error);
        }
      }
    );
  };

  subscribeToChannel(currentVoiceChannelId);

  const unsubscribeFromStore = useServerStore.subscribe((state) => {
    const nextVoiceChannelId = currentVoiceChannelIdSelector(state);

    if (nextVoiceChannelId === currentVoiceChannelId) {
      return;
    }

    currentVoiceChannelId = nextVoiceChannelId;
    subscribeToChannel(nextVoiceChannelId);
  });

  return () => {
    unsubscribeFromStore();
    onStatusChangeSub?.unsubscribe();
  };
};

export { subscribeToIptv };
