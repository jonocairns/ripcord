import { IconButton } from '@/components/ui/icon-button';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import {
  ExternalLink,
  EyeOff,
  Maximize2,
  Minimize2,
  Monitor
} from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent
} from 'react';
import { toast } from 'sonner';
import { CardControls } from './card-controls';
import { useScreenShareZoom } from './hooks/use-screen-share-zoom';
import { useVoiceRefs } from './hooks/use-voice-refs';
import { PinButton } from './pin-button';
import { DEFAULT_WINDOW_FEATURES, PopoutWindow } from './popout-window';
import {
  PopoutVolumePanel,
  PopoutWindowControls
} from './popout-window-controls';
import { StreamSettingsPopover } from './stream-settings-popover';
import { VoiceSurface } from './voice-surface';

type tScreenShareControlsProps = {
  isPinned: boolean;
  handlePinToggle: () => void;
  handleTogglePopout: () => void;
  handleToggleFullscreen: () => void;
  showPinControls: boolean;
  showAudioControl: boolean;
  volume: number;
  isMuted: boolean;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  isFullscreen: boolean;
  isPoppedOut: boolean;
  canStopWatching: boolean;
  onStopWatching?: () => void;
};

const ScreenShareControls = memo(
  ({
    isPinned,
    handlePinToggle,
    handleTogglePopout,
    handleToggleFullscreen,
    showPinControls,
    showAudioControl,
    volume,
    isMuted,
    onVolumeChange,
    onMuteToggle,
    isFullscreen,
    isPoppedOut,
    canStopWatching,
    onStopWatching
  }: tScreenShareControlsProps) => {
    return (
      <CardControls>
        {canStopWatching && onStopWatching && (
          <IconButton
            variant="ghost"
            icon={EyeOff}
            onClick={onStopWatching}
            title="Stop Watching"
            size="default"
          />
        )}
        {showAudioControl && (
          <StreamSettingsPopover
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={onVolumeChange}
            onMuteToggle={onMuteToggle}
          />
        )}
        <IconButton
          variant={isPoppedOut ? 'default' : 'ghost'}
          icon={ExternalLink}
          onClick={handleTogglePopout}
          title={isPoppedOut ? 'Return to In-App' : 'Pop Out Stream'}
          size="default"
        />
        <IconButton
          variant={isFullscreen ? 'default' : 'ghost'}
          icon={isFullscreen ? Minimize2 : Maximize2}
          onClick={handleToggleFullscreen}
          title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          size="default"
        />
        {showPinControls && (
          <PinButton isPinned={isPinned} handlePinToggle={handlePinToggle} />
        )}
      </CardControls>
    );
  }
);

type TScreenShareCardProps = {
  userId: number;
  isPinned?: boolean;
  onPin: () => void;
  onUnpin: () => void;
  className?: string;
  showPinControls: boolean;
  onStopWatching?: () => void;
};

const POPOUT_CONTROLS_IDLE_HIDE_MS = 2500;

const ScreenShareCard = memo(
  ({
    userId,
    isPinned = false,
    onPin,
    onUnpin,
    className,
    showPinControls = true,
    onStopWatching
  }: TScreenShareCardProps) => {
    const user = useUserById(userId);
    const ownUserId = useOwnUserId();
    const { getUserScreenVolumeKey, getVolume, setVolume, toggleMute } =
      useVolumeControl();
    const isOwnUser = ownUserId === userId;
    const volumeKey = getUserScreenVolumeKey(userId);
    const volume = getVolume(volumeKey);
    const isMuted = volume === 0;
    const {
      screenShareRef,
      screenShareAudioRef,
      hasScreenShareStream,
      hasScreenShareAudioStream,
      screenShareStream,
      screenShareAudioStream
    } = useVoiceRefs(userId);
    const [popoutVideoElement, setPopoutVideoElement] =
      useState<HTMLVideoElement | null>(null);
    const [popoutAudioElement, setPopoutAudioElement] =
      useState<HTMLAudioElement | null>(null);

    const {
      containerRef,
      zoom,
      position,
      isDragging,
      handleWheel,
      handleMouseDown,
      handleMouseMove,
      handleMouseUp,
      getCursor,
      resetZoom
    } = useScreenShareZoom();
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isPoppedOut, setIsPoppedOut] = useState(false);
    const [popoutWindow, setPopoutWindow] = useState<Window | null>(null);
    const [isPopoutFullscreen, setIsPopoutFullscreen] = useState(false);
    const [showPopoutWindowControls, setShowPopoutWindowControls] =
      useState(true);
    const hidePopoutWindowControlsTimeoutRef = useRef<number | null>(null);
    const popoutWindowName = useMemo(() => `screen-share-${userId}`, [userId]);

    const handlePinToggle = useCallback(() => {
      if (isPinned) {
        onUnpin?.();
        resetZoom();
      } else {
        onPin?.();
      }
    }, [isPinned, onPin, onUnpin, resetZoom]);

    const handleTogglePopout = useCallback(() => {
      if (isPoppedOut) {
        setIsPoppedOut(false);
        return;
      }

      const activePopoutWindow =
        popoutWindow && !popoutWindow.closed
          ? popoutWindow
          : window.open('', popoutWindowName, DEFAULT_WINDOW_FEATURES);

      if (!activePopoutWindow) {
        toast.error('Pop-out was blocked. Allow pop-ups and try again.');
        setIsPoppedOut(false);
        return;
      }

      setPopoutWindow(activePopoutWindow);
      setIsPoppedOut(true);
      activePopoutWindow.focus();
    }, [isPoppedOut, popoutWindow, popoutWindowName]);

    const handleClosePopout = useCallback(() => {
      setIsPoppedOut(false);
      setPopoutWindow(null);
    }, []);

    const handlePopoutBlocked = useCallback(() => {
      toast.error('Pop-out was blocked. Allow pop-ups and try again.');
      setIsPoppedOut(false);
      setPopoutWindow(null);
    }, []);

    const handleToggleFullscreen = useCallback(() => {
      const container = containerRef.current;

      if (!container) return;

      if (document.fullscreenElement === container) {
        void document.exitFullscreen();
      } else {
        void container.requestFullscreen();
      }
    }, [containerRef]);

    const handleTogglePopoutFullscreen = useCallback(() => {
      const popoutDocument = popoutVideoElement?.ownerDocument;

      if (!popoutDocument) return;

      if (popoutDocument.fullscreenElement) {
        void popoutDocument.exitFullscreen();
        return;
      }

      void popoutDocument.documentElement.requestFullscreen();
    }, [popoutVideoElement]);

    const handleVolumeChange = useCallback(
      (newVolume: number) => {
        setVolume(volumeKey, newVolume);
      },
      [setVolume, volumeKey]
    );

    const handleMuteToggle = useCallback(() => {
      toggleMute(volumeKey);
    }, [toggleMute, volumeKey]);

    const handlePopoutVolumeChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        setVolume(volumeKey, Number(e.target.value));
      },
      [setVolume, volumeKey]
    );

    const clearPopoutControlsHideTimeout = useCallback(() => {
      if (hidePopoutWindowControlsTimeoutRef.current === null) {
        return;
      }

      window.clearTimeout(hidePopoutWindowControlsTimeoutRef.current);
      hidePopoutWindowControlsTimeoutRef.current = null;
    }, []);

    const revealPopoutWindowControls = useCallback(() => {
      setShowPopoutWindowControls(true);
      clearPopoutControlsHideTimeout();

      hidePopoutWindowControlsTimeoutRef.current = window.setTimeout(() => {
        setShowPopoutWindowControls(false);
        hidePopoutWindowControlsTimeoutRef.current = null;
      }, POPOUT_CONTROLS_IDLE_HIDE_MS);
    }, [clearPopoutControlsHideTimeout]);

    useEffect(() => {
      const handleFullscreenChange = () => {
        setIsFullscreen(document.fullscreenElement === containerRef.current);
      };

      document.addEventListener('fullscreenchange', handleFullscreenChange);
      handleFullscreenChange();

      return () => {
        document.removeEventListener(
          'fullscreenchange',
          handleFullscreenChange
        );
      };
    }, [containerRef]);

    useEffect(() => {
      if (!isPoppedOut) {
        clearPopoutControlsHideTimeout();
        setShowPopoutWindowControls(true);
        setIsPopoutFullscreen(false);
        return;
      }

      revealPopoutWindowControls();
    }, [
      clearPopoutControlsHideTimeout,
      isPoppedOut,
      revealPopoutWindowControls
    ]);

    useEffect(() => {
      return () => {
        clearPopoutControlsHideTimeout();
      };
    }, [clearPopoutControlsHideTimeout]);

    useEffect(() => {
      if (!screenShareAudioRef.current) {
        return;
      }

      screenShareAudioRef.current.muted = isPoppedOut;
    }, [isPoppedOut, screenShareAudioRef]);

    useEffect(() => {
      const popoutVideo = popoutVideoElement;

      if (!popoutVideo) {
        return;
      }

      if (!isPoppedOut || !screenShareStream) {
        popoutVideo.srcObject = null;
        return;
      }

      if (popoutVideo.srcObject !== screenShareStream) {
        popoutVideo.srcObject = screenShareStream;
      }
    }, [isPoppedOut, popoutVideoElement, screenShareStream]);

    useEffect(() => {
      if (!isPoppedOut || !popoutVideoElement) {
        return;
      }

      const popoutDocument = popoutVideoElement.ownerDocument;
      const popoutWindow = popoutDocument.defaultView;

      if (!popoutWindow) {
        return;
      }

      const handlePopoutMouseMove = () => {
        if (!popoutDocument.hasFocus()) {
          return;
        }

        revealPopoutWindowControls();
      };

      const handlePopoutFocus = () => {
        revealPopoutWindowControls();
      };

      const handlePopoutBlur = () => {
        clearPopoutControlsHideTimeout();
        setShowPopoutWindowControls(false);
      };

      const handlePopoutFullscreenChange = () => {
        setIsPopoutFullscreen(!!popoutDocument.fullscreenElement);
      };

      popoutDocument.addEventListener('mousemove', handlePopoutMouseMove);
      popoutDocument.addEventListener(
        'fullscreenchange',
        handlePopoutFullscreenChange
      );
      popoutWindow.addEventListener('focus', handlePopoutFocus);
      popoutWindow.addEventListener('blur', handlePopoutBlur);

      handlePopoutFullscreenChange();

      if (popoutDocument.hasFocus()) {
        revealPopoutWindowControls();
      } else {
        setShowPopoutWindowControls(false);
      }

      return () => {
        popoutDocument.removeEventListener('mousemove', handlePopoutMouseMove);
        popoutDocument.removeEventListener(
          'fullscreenchange',
          handlePopoutFullscreenChange
        );
        popoutWindow.removeEventListener('focus', handlePopoutFocus);
        popoutWindow.removeEventListener('blur', handlePopoutBlur);
      };
    }, [
      clearPopoutControlsHideTimeout,
      isPoppedOut,
      popoutVideoElement,
      revealPopoutWindowControls
    ]);

    useEffect(() => {
      const popoutAudio = popoutAudioElement;

      if (!popoutAudio) {
        return;
      }

      if (!isPoppedOut || !screenShareAudioStream) {
        popoutAudio.srcObject = null;
        return;
      }

      if (popoutAudio.srcObject !== screenShareAudioStream) {
        popoutAudio.srcObject = screenShareAudioStream;
      }
    }, [isPoppedOut, popoutAudioElement, screenShareAudioStream]);

    useEffect(() => {
      const popoutAudio = popoutAudioElement;

      if (!popoutAudio) {
        return;
      }

      popoutAudio.volume = volume / 100;
      popoutAudio.muted = isMuted;
    }, [isMuted, popoutAudioElement, volume]);

    useEffect(() => {
      if (hasScreenShareStream) {
        return;
      }

      setIsPoppedOut(false);
      setPopoutWindow(null);
    }, [hasScreenShareStream]);

    if (!user || !hasScreenShareStream) return null;

    return (
      <>
        <VoiceSurface
          ref={containerRef}
          className={cn(
            'relative group',
            'flex items-center justify-center',
            'w-full h-full',
            className
          )}
          onWheel={isPoppedOut ? undefined : handleWheel}
          onMouseDown={isPoppedOut ? undefined : handleMouseDown}
          onMouseMove={isPoppedOut ? undefined : handleMouseMove}
          onMouseUp={isPoppedOut ? undefined : handleMouseUp}
          onMouseLeave={isPoppedOut ? undefined : handleMouseUp}
          style={{
            cursor: isPoppedOut ? 'default' : getCursor()
          }}
        >
          <ScreenShareControls
            isPinned={isPinned}
            handlePinToggle={handlePinToggle}
            handleTogglePopout={handleTogglePopout}
            handleToggleFullscreen={handleToggleFullscreen}
            showPinControls={showPinControls}
            showAudioControl={
              !isOwnUser && hasScreenShareAudioStream && !isPoppedOut
            }
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={handleVolumeChange}
            onMuteToggle={handleMuteToggle}
            isFullscreen={isFullscreen}
            isPoppedOut={isPoppedOut}
            canStopWatching={!isOwnUser}
            onStopWatching={onStopWatching}
          />

          <video
            ref={screenShareRef}
            autoPlay
            muted={isOwnUser || isPoppedOut}
            playsInline
            className={cn(
              'absolute inset-0 h-full w-full bg-[#1b2026] object-contain',
              isPoppedOut && 'opacity-0 pointer-events-none'
            )}
            style={{
              transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
              transition: isDragging ? 'none' : 'transform 0.1s ease-out'
            }}
            onDoubleClick={isPoppedOut ? undefined : handleToggleFullscreen}
          />

          <audio
            ref={screenShareAudioRef}
            className="hidden"
            autoPlay
            playsInline
          />

          {isPoppedOut && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/85 text-white p-4 text-center">
              <Monitor className="size-8 text-purple-400" />
              <div className="space-y-1">
                <p className="text-sm font-semibold">{user.name}'s screen</p>
                <p className="text-xs text-white/70">
                  Opened in a pop-out window
                </p>
              </div>
              <button
                type="button"
                className="cursor-pointer rounded-md border border-white/20 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/10"
                onClick={handleClosePopout}
              >
                Return to in-app
              </button>
            </div>
          )}
        </VoiceSurface>

        <PopoutWindow
          isOpen={isPoppedOut}
          windowName={popoutWindowName}
          title={`${user.name}'s screen - Sharkord`}
          onClose={handleClosePopout}
          onBlocked={handlePopoutBlocked}
          targetWindow={popoutWindow}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              position: 'relative',
              backgroundColor: '#000000',
              color: '#ffffff'
            }}
          >
            <PopoutWindowControls
              visible={showPopoutWindowControls}
              isFullscreen={isPopoutFullscreen}
              onToggleFullscreen={handleTogglePopoutFullscreen}
            >
              {!isOwnUser && hasScreenShareAudioStream && (
                <PopoutVolumePanel
                  volume={volume}
                  isMuted={isMuted}
                  onMuteToggle={handleMuteToggle}
                  onVolumeChange={handlePopoutVolumeChange}
                />
              )}
            </PopoutWindowControls>

            <div
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                height: '100%',
                backgroundColor: '#000000'
              }}
            >
              <video
                ref={setPopoutVideoElement}
                autoPlay
                muted
                playsInline
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  backgroundColor: '#000000'
                }}
              />
              {!isOwnUser && hasScreenShareAudioStream && (
                <audio
                  ref={setPopoutAudioElement}
                  autoPlay
                  playsInline
                  style={{ display: 'none' }}
                />
              )}
            </div>
          </div>
        </PopoutWindow>
      </>
    );
  }
);

ScreenShareCard.displayName = 'ScreenShareCard';

export { ScreenShareCard };
