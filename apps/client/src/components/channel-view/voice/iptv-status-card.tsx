import { cn } from '@/lib/utils';
import type { TIptvStatus } from '@sharkord/shared';
import { AlertTriangle, LoaderCircle, Tv } from 'lucide-react';
import { memo } from 'react';
import { CardGradient } from './card-gradient';

type TIptvStatusCardProps = {
  status: TIptvStatus;
  canManageIptv: boolean;
  className?: string;
};

const IptvStatusCard = memo(
  ({ status, canManageIptv, className }: TIptvStatusCardProps) => {
    const activeChannelName = status.activeChannel?.name;
    const isStarting = status.status === 'starting';
    const title = isStarting
      ? activeChannelName
        ? `Connecting to ${activeChannelName}`
        : 'Connecting to IPTV stream'
      : activeChannelName
        ? `${activeChannelName} is unavailable`
        : 'IPTV stream unavailable';
    const description = isStarting
      ? 'Trying to open the source stream and negotiate video and audio.'
      : status.error ||
        'The source did not produce usable video or audio after multiple retry attempts.';
    const recoveryMessage = isStarting
      ? 'This can take a moment while the source responds.'
      : canManageIptv
        ? 'Check the source stream or switch to another IPTV channel from the TV menu.'
        : 'Ask someone with Manage IPTV permission to check the source or switch channels.';

    return (
      <div
        className={cn(
          'relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl bg-card shadow-[0_10px_32px_rgb(0_0_0/0.38)]',
          isStarting
            ? 'border border-amber-500/30'
            : 'border border-red-500/30',
          className
        )}
      >
        <CardGradient />

        <div className="relative z-10 flex max-w-lg flex-col items-center gap-4 px-6 py-8 text-center">
          <div
            className={cn(
              'flex h-20 w-20 items-center justify-center rounded-full md:h-24 md:w-24',
              isStarting
                ? 'border border-amber-400/30 bg-amber-500/12'
                : 'border border-red-400/30 bg-red-500/12'
            )}
          >
            <div className="relative">
              <Tv className="size-10 text-white/70 md:size-12" />
              {isStarting ? (
                <LoaderCircle className="absolute -right-2 -top-2 size-5 animate-spin text-amber-300 md:size-6" />
              ) : (
                <AlertTriangle className="absolute -right-2 -top-2 size-5 text-red-300 md:size-6" />
              )}
            </div>
          </div>

          <div
            className={cn(
              'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em]',
              isStarting
                ? 'bg-amber-500/12 text-amber-100'
                : 'bg-red-500/12 text-red-100'
            )}
          >
            {isStarting ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <AlertTriangle className="size-3.5" />
            )}
            <span>{isStarting ? 'IPTV Loading' : 'IPTV Error'}</span>
          </div>

          <div className="space-y-2">
            <p className="text-lg font-semibold text-white">{title}</p>
            <p className="text-sm text-white/80">{description}</p>
            <p className="text-sm text-white/60">{recoveryMessage}</p>
          </div>
        </div>
      </div>
    );
  }
);

IptvStatusCard.displayName = 'IptvStatusCard';

export { IptvStatusCard };
