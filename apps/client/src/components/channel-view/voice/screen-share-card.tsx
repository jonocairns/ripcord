import { useUserById } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { Monitor } from 'lucide-react';
import { memo, useCallback } from 'react';
import { CardGradient } from './card-gradient';
import { useVoiceRefs } from './hooks/use-voice-refs';
import { PinButton } from './pin-button';

type TScreenShareCardProps = {
  userId: number;
  isPinned?: boolean;
  onPin: () => void;
  onUnpin: () => void;
  className?: string;
  showPinControls: boolean;
};

const ScreenShareCard = memo(
  ({
    userId,
    isPinned = false,
    onPin,
    onUnpin,
    className,
    showPinControls = true
  }: TScreenShareCardProps) => {
    const user = useUserById(userId);
    const { screenShareRef, hasScreenShareStream } = useVoiceRefs(userId);

    const handlePinToggle = useCallback(() => {
      if (isPinned) {
        onUnpin?.();
      } else {
        onPin?.();
      }
    }, [isPinned, onPin, onUnpin]);

    if (!user || !hasScreenShareStream) return null;

    return (
      <div
        className={cn(
          'relative bg-card border border-border rounded-lg overflow-hidden group',
          'flex items-center justify-center',
          'min-h-0 aspect-video',
          className
        )}
      >
        <CardGradient />
        {showPinControls && (
          <PinButton isPinned={isPinned} handlePinToggle={handlePinToggle} />
        )}

        <video
          ref={screenShareRef}
          autoPlay
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-contain bg-black"
        />

        <div className="absolute bottom-0 left-0 right-0 p-3 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="flex items-center gap-2 min-w-0">
            <Monitor className="h-4 w-4 text-purple-400 flex-shrink-0" />
            <span className="text-white font-medium text-sm truncate">
              {user.name}'s screen
            </span>
          </div>
        </div>
      </div>
    );
  }
);

ScreenShareCard.displayName = 'ScreenShareCard';

export { ScreenShareCard };
