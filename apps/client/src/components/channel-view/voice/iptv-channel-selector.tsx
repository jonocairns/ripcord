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
import {
  LoaderCircle,
  Pin,
  PinOff,
  Play,
  Search,
  Square,
  Tv
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { toast } from 'sonner';

type TIptvChannelSelectorProps = {
  channelId: number;
  canManageIptv: boolean;
  className?: string;
};

type TGroupedChannels = Array<{
  group: string;
  channels: Array<{ index: number; channel: TIptvChannel }>;
}>;

type TChannelEntry = {
  index: number;
  channel: TIptvChannel;
};

type TChannelListRow =
  | {
      type: 'header';
      key: string;
      label: string;
    }
  | {
      type: 'channel';
      key: string;
      index: number;
      channel: TIptvChannel;
    };

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
  ({ channelId, canManageIptv, className }: TIptvChannelSelectorProps) => {
    const status = useIptvStatusByChannelId(channelId);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [channels, setChannels] = useState<TIptvChannel[]>([]);
    const [search, setSearch] = useState('');
    const [configured, setConfigured] = useState(false);
    const [enabled, setEnabled] = useState(false);
    const [pinnedChannelUrls, setPinnedChannelUrls] = useState<string[]>([]);
    const [actionIndex, setActionIndex] = useState<number | undefined>();
    const [pinningChannelUrl, setPinningChannelUrl] = useState<
      string | undefined
    >();
    const [stopping, setStopping] = useState(false);
    const isMountedRef = useRef(true);
    const normalizedSearch = search.trim().toLowerCase();

    useEffect(() => {
      return () => {
        isMountedRef.current = false;
      };
    }, []);

    useEffect(() => {
      let cancelled = false;
      const trpc = getTRPCClient();

      void (async () => {
        try {
          const config = await trpc.iptv.getViewerConfig.query({
            channelId
          });

          if (cancelled) {
            return;
          }

          setConfigured(config.configured);
          setEnabled(config.enabled);
          setPinnedChannelUrls(config.pinnedChannelUrls);
        } catch {
          if (!cancelled) {
            setConfigured(false);
            setEnabled(false);
            setPinnedChannelUrls([]);
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [channelId]);

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

    const pinnedChannelUrlSet = useMemo(
      () => new Set(pinnedChannelUrls),
      [pinnedChannelUrls]
    );

    const pinnedChannels = useMemo<TChannelEntry[]>(
      () =>
        filteredChannels.filter(({ channel }) =>
          pinnedChannelUrlSet.has(channel.url)
        ),
      [filteredChannels, pinnedChannelUrlSet]
    );

    const groupedChannels = useMemo<TGroupedChannels>(() => {
      const grouped = new Map<
        string,
        Array<{ index: number; channel: TIptvChannel }>
      >();

      filteredChannels.forEach(({ channel, index }) => {
        if (pinnedChannelUrlSet.has(channel.url)) {
          return;
        }

        const groupName = channel.group?.trim() || 'Other';
        const existing = grouped.get(groupName) ?? [];

        grouped.set(groupName, [...existing, { index, channel }]);
      });

      return Array.from(grouped.entries()).map(([group, groupedChannels]) => ({
        group,
        channels: groupedChannels
      }));
    }, [filteredChannels, pinnedChannelUrlSet]);
    const channelRows = useMemo<TChannelListRow[]>(() => {
      const rows: TChannelListRow[] = [];

      if (pinnedChannels.length > 0) {
        rows.push({
          type: 'header',
          key: 'header-pinned',
          label: 'Pinned'
        });

        pinnedChannels.forEach(({ index, channel }) => {
          rows.push({
            type: 'channel',
            key: `pinned-${channel.url}-${index}`,
            index,
            channel
          });
        });
      }

      groupedChannels.forEach((grouped) => {
        rows.push({
          type: 'header',
          key: `header-${grouped.group}`,
          label: grouped.group
        });

        grouped.channels.forEach(({ index, channel }) => {
          rows.push({
            type: 'channel',
            key: `${grouped.group}-${channel.url}-${index}`,
            index,
            channel
          });
        });
      });

      return rows;
    }, [groupedChannels, pinnedChannels]);
    const hasVisibleChannels = channelRows.length > 0;

    const refresh = useCallback(async () => {
      setLoading(true);
      const trpc = getTRPCClient();

      try {
        const config = await trpc.iptv.getViewerConfig.query({
          channelId
        });

        if (!isMountedRef.current) {
          return;
        }

        if (!config.configured) {
          setConfigured(false);
          setEnabled(false);
          setPinnedChannelUrls([]);
          setChannels([]);
          return;
        }

        setConfigured(true);
        setEnabled(config.enabled);
        setPinnedChannelUrls(config.pinnedChannelUrls);

        const currentStatusPromise = trpc.iptv.getStatus.query({
          channelId
        });

        if (!config.enabled) {
          setChannels([]);
          const currentStatus = await currentStatusPromise;

          if (!isMountedRef.current) {
            return;
          }

          setIptvStatus(channelId, currentStatus);
          return;
        }

        const list = await trpc.iptv.listChannels.query({
          channelId
        });

        if (!isMountedRef.current) {
          return;
        }

        setChannels(list);

        const currentStatus = await currentStatusPromise;

        if (!isMountedRef.current) {
          return;
        }

        setIptvStatus(channelId, currentStatus);
      } catch (error) {
        if (isMountedRef.current) {
          toast.error(getTrpcError(error, 'Failed to load IPTV channels'));
        }
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
        }
      }
    }, [channelId]);

    const onOpenChange = useCallback(
      (nextOpen: boolean) => {
        setOpen(nextOpen);

        if (!nextOpen) {
          setSearch('');
          return;
        }

        void refresh();
      },
      [refresh]
    );

    const setPinnedChannel = useCallback(
      async (channelUrl: string, pinned: boolean) => {
        setPinningChannelUrl(channelUrl);
        const trpc = getTRPCClient();

        try {
          const result = await trpc.iptv.setPinnedChannel.mutate({
            channelId,
            channelUrl,
            pinned
          });

          setPinnedChannelUrls(result.pinnedChannelUrls);
        } catch (error) {
          toast.error(getTrpcError(error, 'Failed to update pinned channel'));
        } finally {
          setPinningChannelUrl(undefined);
        }
      },
      [channelId]
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

    if (!configured) {
      return null;
    }

    const currentStatus = status?.status ?? 'idle';
    const activeIndex = status?.activeChannel?.index;
    const renderChannelRow = (index: number, channel: TIptvChannel) => {
      const isActive = status?.status === 'streaming' && activeIndex === index;
      const isPinned = pinnedChannelUrlSet.has(channel.url);

      return (
        <div
          className={cn(
            'flex items-center justify-between rounded-md border p-2',
            isActive && 'border-emerald-500/50 bg-emerald-500/10'
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {channel.logo ? (
              <img
                src={channel.logo}
                alt={channel.name}
                className="h-5 w-5 shrink-0 rounded-sm object-cover"
              />
            ) : (
              <Tv className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span
              className="block min-w-0 flex-1 truncate text-sm"
              title={channel.name}
            >
              {channel.name}
            </span>
          </div>

          {canManageIptv && (
            <div className="ml-2 flex shrink-0 items-center gap-1">
              <Button
                variant={isPinned ? 'secondary' : 'ghost'}
                size="icon"
                onClick={() => void setPinnedChannel(channel.url, !isPinned)}
                disabled={pinningChannelUrl === channel.url}
                className="h-7 w-7"
                aria-label={
                  isPinned ? 'Unpin IPTV channel' : 'Pin IPTV channel'
                }
              >
                {pinningChannelUrl === channel.url ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : isPinned ? (
                  <PinOff className="size-3.5" />
                ) : (
                  <Pin className="size-3.5" />
                )}
              </Button>
              <Button
                size="sm"
                variant={isActive ? 'secondary' : 'default'}
                onClick={() => void playChannel(index)}
                disabled={actionIndex !== undefined || stopping}
                className="h-7 shrink-0"
              >
                {actionIndex === index ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {isActive ? 'Playing' : 'Play'}
              </Button>
            </div>
          )}
        </div>
      );
    };

    return (
      <div className={className}>
        <Popover open={open} onOpenChange={onOpenChange}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 rounded-md border border-border/50 bg-card/90 shadow-xl backdrop-blur-md transition-all duration-200 hover:bg-muted/60"
              aria-label="IPTV channels"
            >
              <Tv size={22} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[24rem] max-w-[90vw] p-3">
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

              {!enabled && (
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
                !hasVisibleChannels &&
                normalizedSearch && (
                  <p className="text-xs text-muted-foreground">
                    No channels matched &quot;{search.trim()}&quot;.
                  </p>
                )}

              {!loading && enabled && hasVisibleChannels && (
                <Virtuoso
                  style={{ height: 288 }}
                  totalCount={channelRows.length}
                  overscan={320}
                  computeItemKey={(rowIndex) =>
                    channelRows[rowIndex]?.key ?? rowIndex
                  }
                  itemContent={(rowIndex) => {
                    const row = channelRows[rowIndex];

                    if (!row) {
                      return null;
                    }

                    if (row.type === 'header') {
                      return (
                        <div className="pb-1 pt-2 first:pt-0">
                          <p className="text-xs font-medium text-muted-foreground">
                            {row.label}
                          </p>
                        </div>
                      );
                    }

                    return (
                      <div className="pb-1">
                        {renderChannelRow(row.index, row.channel)}
                      </div>
                    );
                  }}
                />
              )}

              {!canManageIptv && enabled && (
                <p className="text-xs text-muted-foreground">
                  You can browse channels, but only users with Manage IPTV can
                  switch streams.
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    );
  }
);

export { IptvChannelSelector };
