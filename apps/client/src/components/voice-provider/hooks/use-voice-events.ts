import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { getTRPCClient, type AppRouter } from '@/lib/trpc';
import type { TRPCClient } from '@trpc/client';
import { useEffect } from 'react';

type Client = TRPCClient<AppRouter>;

type TEvents = {
  onNewProducer: Parameters<
    Client['voice']['onNewProducer']['subscribe']
  >[1]['onData'];
  onProducerClosed: Parameters<
    Client['voice']['onProducerClosed']['subscribe']
  >[1]['onData'];
  onUserLeave: Parameters<Client['voice']['onLeave']['subscribe']>[1]['onData'];
};

const useVoiceEvents = (events: TEvents) => {
  const channelId = useCurrentVoiceChannelId();

  useEffect(() => {
    const { onNewProducer, onProducerClosed } = events;

    const trpc = getTRPCClient();

    const onVoiceNewProducerSub = trpc.voice.onNewProducer.subscribe(
      undefined,
      {
        onData: (data) => {
          if (data.channelId !== channelId) return;
          onNewProducer?.(data);
        },
        onError: (err) => {
          console.error('onVoiceNewProducer subscription error:', err);
        }
      }
    );

    const onVoiceProducerClosedSub = trpc.voice.onProducerClosed.subscribe(
      undefined,
      {
        onData: (data) => {
          if (data.channelId !== channelId) return;
          onProducerClosed?.(data);
        },
        onError: (err) => {
          console.error('onVoiceProducerClosed subscription error:', err);
        }
      }
    );

    const onVoiceUserLeaveSub = trpc.voice.onLeave.subscribe(undefined, {
      onData: (data) => {
        if (data.channelId !== channelId) return;
        events.onUserLeave?.(data);
      },
      onError: (err) => {
        console.error('onVoiceUserLeave subscription error:', err);
      }
    });

    return () => {
      onVoiceNewProducerSub.unsubscribe();
      onVoiceProducerClosedSub.unsubscribe();
      onVoiceUserLeaveSub.unsubscribe();
    };
  }, [channelId, events]);
};

type TNewProducerParams = NonNullable<
  Parameters<typeof useVoiceEvents>[0]['onNewProducer']
>;

type TProducerClosedParams = NonNullable<
  Parameters<typeof useVoiceEvents>[0]['onProducerClosed']
>;

type TUserLeaveParams = NonNullable<
  Parameters<typeof useVoiceEvents>[0]['onUserLeave']
>;

export { useVoiceEvents };
export type { TNewProducerParams, TProducerClosedParams, TUserLeaveParams };
