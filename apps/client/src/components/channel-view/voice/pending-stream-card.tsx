import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { useUserById } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { StreamKind } from '@sharkord/shared';
import { Headphones, Monitor, Router, Video } from 'lucide-react';
import { memo } from 'react';
import { CardGradient } from './card-gradient';

type TPendingStreamCardProps = {
  kind: StreamKind;
  onWatch: () => void;
  userId?: number;
  streamTitle?: string;
  streamAvatarUrl?: string;
  className?: string;
};

const getPendingStreamDetails = (
  kind: StreamKind,
  displayName: string
): {
  label: string;
  description: string;
  icon: typeof Video;
} => {
  switch (kind) {
    case StreamKind.SCREEN:
    case StreamKind.SCREEN_AUDIO:
      return {
        label: 'Screen Share',
        description: `${displayName} is sharing their screen`,
        icon: Monitor
      };
    case StreamKind.VIDEO:
      return {
        label: 'Camera',
        description: `${displayName} has their camera on`,
        icon: Video
      };
    case StreamKind.EXTERNAL_AUDIO:
      return {
        label: 'External Audio',
        description: `${displayName} is ready to listen`,
        icon: Headphones
      };
    case StreamKind.EXTERNAL_VIDEO:
      return {
        label: 'External Stream',
        description: `${displayName} is ready to watch`,
        icon: Router
      };
    case StreamKind.AUDIO:
      return {
        label: 'Audio',
        description: `${displayName} is speaking`,
        icon: Headphones
      };
  }
};

const PendingStreamCard = memo(
  ({
    kind,
    onWatch,
    userId,
    streamTitle,
    streamAvatarUrl,
    className
  }: TPendingStreamCardProps) => {
    const user = useUserById(userId ?? 0);
    const displayName = user?.name || streamTitle || 'This stream';
    const {
      label,
      description,
      icon: Icon
    } = getPendingStreamDetails(kind, displayName);

    return (
      <div
        className={cn(
          'relative bg-card rounded-xl overflow-hidden',
          'flex items-center justify-center',
          'w-full h-full',
          'border border-border/70 shadow-[0_10px_32px_rgb(0_0_0/0.38)]',
          className
        )}
      >
        <CardGradient />

        <div className="relative z-10 flex max-w-md flex-col items-center gap-4 px-6 py-8 text-center">
          {userId && user ? (
            <UserAvatar
              userId={userId}
              className="h-20 w-20 border-2 border-white/15 md:h-24 md:w-24"
              showStatusBadge={false}
            />
          ) : (
            <Avatar className="h-20 w-20 border-2 border-white/15 md:h-24 md:w-24">
              {streamAvatarUrl ? (
                <AvatarImage src={streamAvatarUrl} alt={displayName} />
              ) : null}
              <AvatarFallback className="bg-muted/40">
                <Icon className="size-8 text-white/80" />
              </AvatarFallback>
            </Avatar>
          )}

          <div className="inline-flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-white/70">
            <Icon className="size-3.5" />
            <span>{label}</span>
          </div>

          <div className="space-y-1">
            <p className="text-lg font-semibold text-white">{displayName}</p>
            <p className="text-sm text-white/70">{description}</p>
          </div>

          <Button type="button" size="sm" onClick={onWatch}>
            Watch
          </Button>
        </div>
      </div>
    );
  }
);

PendingStreamCard.displayName = 'PendingStreamCard';

export { PendingStreamCard };
