import { getTRPCClient } from '@/lib/trpc';
import { setIptvStatus } from './actions';

const subscribeToIptv = () => {
  const trpc = getTRPCClient();
  const onStatusChangeSub = trpc.iptv.onStatusChange.subscribe(undefined, {
    onData: ({ channelId, ...status }) => {
      setIptvStatus(channelId, status);
    },
    onError: (error) => {
      console.error('iptv.onStatusChange subscription error:', error);
    }
  });

  return () => {
    onStatusChangeSub.unsubscribe();
  };
};

export { subscribeToIptv };
