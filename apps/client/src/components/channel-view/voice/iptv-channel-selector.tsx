import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover';
import { setIptvStatus } from '@/features/server/iptv/actions';
import { useIptvStatusByChannelId } from '@/features/server/iptv/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { type TIptvChannel } from '@sharkord/shared';
import { LoaderCircle, Play, Search, Square, Tv } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

type TIptvChannelSelectorProps = {
  channelId: number;
  canManageIptv: boolean;
  visible: boolean;
};

type TGroupedChannels = Array<{
  group: string;
  channels: Array<{ index: number; channel: TIptvChannel }>;
}>;

const IPTV_STATUS_LABELS: Record<
  'idle' | 'starting' | 'streaming' | 'error',
  string
> = {
  idle: 'Idle',
  starting: 'Starting',
  streaming: 'Streaming',
  error: 'Error'
};

const IptvChannelSelector = memo(
  ({ channelId, canManageIptv, visible }: TIptvChannelSelectorProps) => {
    const status = useIptvStatusByChannelId(channelId);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [channels, setChannels] = useState<TIptvChannel[]>([]);
    const [search, setSearch] = useState('');
    const [configured, setConfigured] = useState(false);
    const [enabled, setEnabled] = useState(false);
    const [actionIndex, setActionIndex] = useState<number | undefined>();
    const [stopping, setStopping] = useState(false);
    const normalizedSearch = search.trim().toLowerCase();

    const filteredChannels = useMemo(
      () =>
        channels
          .map((channel, index) => ({
            index,
            channel
          }))
          .filter(({ channel }) => {
            if (!normalizedSearch) {
              return true;
            }

            const name = channel.name.toLowerCase();
            const group = channel.group?.toLowerCase() ?? '';

            return (
              name.includes(normalizedSearch) ||
              group.includes(normalizedSearch)
            );
          }),
      [channels, normalizedSearch]
    );

    const groupedChannels = useMemo<TGroupedChannels>(() => {
      const grouped = new Map<
        string,
        Array<{ index: number; channel: TIptvChannel }>
      >();

      filteredChannels.forEach(({ channel, index }) => {
        const groupName = channel.group?.trim() || 'Other';
        const existing = grouped.get(groupName) ?? [];

        grouped.set(groupName, [...existing, { index, channel }]);
      });

      return Array.from(grouped.entries()).map(([group, groupedChannels]) => ({
        group,
        channels: groupedChannels
      }));
    }, [filteredChannels]);

    const refresh = useCallback(async () => {
      setLoading(true);
      const trpc = getTRPCClient();

      try {
        const config = await trpc.iptv.getConfig.query({
          channelId
        });

        if (!config) {
          setConfigured(false);
          setEnabled(false);
          setChannels([]);
          return;
        }

        setConfigured(true);
        setEnabled(config.enabled);

        const currentStatus = await trpc.iptv.getStatus.query({
          channelId
        });

        setIptvStatus(channelId, currentStatus);

        if (!config.enabled) {
          setChannels([]);
          return;
        }

        const list = await trpc.iptv.listChannels.query({
          channelId
        });

        setChannels(list);
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to load IPTV channels'));
      } finally {
        setLoading(false);
      }
    }, [channelId]);

    const onOpenChange = useCallback(
      (nextOpen: boolean) => {
        setOpen(nextOpen);

        if (!nextOpen) {
          setSearch('');
          return;
        }

        if (nextOpen) {
          void refresh();
        }
      },
      [refresh]
    );

    const playChannel = useCallback(
      async (channelIndex: number) => {
        setActionIndex(channelIndex);
        const trpc = getTRPCClient();

        try {
          const nextStatus = await trpc.iptv.play.mutate({
            channelId,
            channelIndex
          });

          setIptvStatus(channelId, nextStatus);
        } catch (error) {
          toast.error(getTrpcError(error, 'Failed to play IPTV channel'));
        } finally {
          setActionIndex(undefined);
        }
      },
      [channelId]
    );

    const stopStream = useCallback(async () => {
      setStopping(true);
      const trpc = getTRPCClient();

      try {
        const nextStatus = await trpc.iptv.stop.mutate({
          channelId
        });

        setIptvStatus(channelId, nextStatus);
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to stop IPTV stream'));
      } finally {
        setStopping(false);
      }
    }, [channelId]);

    if (!visible) {
      return null;
    }

    const currentStatus = status?.status ?? 'idle';
    const activeIndex = status?.activeChannel?.index;

    return (
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-md h-10 w-10 transition-all duration-200 hover:bg-muted/60"
            aria-label="IPTV channels"
          >
            <Tv size={22} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-[24rem] max-w-[90vw] p-3">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Tv className="size-4" />
                <h4 className="text-sm font-semibold">IPTV</h4>
                <span
                  className={cn(
                    'h-2 w-2 rounded-full',
                    currentStatus === 'streaming'
                      ? 'bg-emerald-500'
                      : currentStatus === 'starting'
                        ? 'bg-amber-500'
                        : currentStatus === 'error'
                          ? 'bg-red-500'
                          : 'bg-muted-foreground/50'
                  )}
                />
                <span className="text-xs text-muted-foreground">
                  {IPTV_STATUS_LABELS[currentStatus]}
                </span>
              </div>
              {canManageIptv && status?.status === 'streaming' && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={stopStream}
                  disabled={stopping}
                  className="h-7"
                >
                  {stopping ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Square className="size-3.5" />
                  )}
                  Stop
                </Button>
              )}
            </div>

            {status?.error && (
              <p className="text-xs text-red-500">{status.error}</p>
            )}

            {!configured && (
              <p className="text-xs text-muted-foreground">
                IPTV is not configured for this channel.
              </p>
            )}

            {configured && !enabled && (
              <p className="text-xs text-muted-foreground">
                IPTV is configured but currently disabled by an admin.
              </p>
            )}

            {loading && (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
              </div>
            )}

            {!loading && enabled && channels.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No channels found in this playlist.
              </p>
            )}

            {!loading && enabled && channels.length > 0 && (
              <div className="relative">
                <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search channels..."
                  className="h-8 pl-7 text-xs"
                />
              </div>
            )}

            {!loading &&
              enabled &&
              channels.length > 0 &&
              groupedChannels.length === 0 &&
              normalizedSearch && (
                <p className="text-xs text-muted-foreground">
                  No channels matched &quot;{search.trim()}&quot;.
                </p>
              )}

            {!loading && enabled && groupedChannels.length > 0 && (
              <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
                {groupedChannels.map((grouped) => (
                  <div key={grouped.group} className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">
                      {grouped.group}
                    </p>
                    {grouped.channels.map(({ index, channel }) => {
                      const isActive =
                        status?.status === 'streaming' && activeIndex === index;

                      return (
                        <div
                          key={`${grouped.group}-${index}`}
                          className={cn(
                            'flex items-center justify-between rounded-md border p-2',
                            isActive &&
                              'border-emerald-500/50 bg-emerald-500/10'
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            {channel.logo ? (
                              <img
                                src={channel.logo}
                                alt={channel.name}
                                className="h-5 w-5 rounded-sm object-cover"
                              />
                            ) : (
                              <Tv className="size-4 text-muted-foreground" />
                            )}
                            <span className="truncate text-sm">
                              {channel.name}
                            </span>
                          </div>

                          {canManageIptv && (
                            <Button
                              size="sm"
                              variant={isActive ? 'secondary' : 'default'}
                              onClick={() => void playChannel(index)}
                              disabled={actionIndex !== undefined || stopping}
                              className="h-7"
                            >
                              {actionIndex === index ? (
                                <LoaderCircle className="size-3.5 animate-spin" />
                              ) : (
                                <Play className="size-3.5" />
                              )}
                              {isActive ? 'Playing' : 'Play'}
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}

            {!canManageIptv && configured && enabled && (
              <p className="text-xs text-muted-foreground">
                You can browse channels, but only users with Manage IPTV can
                switch streams.
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  }
);

export { IptvChannelSelector };
