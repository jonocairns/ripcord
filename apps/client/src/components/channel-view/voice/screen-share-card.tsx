import { IconButton } from '@/components/ui/icon-button';
import {
  useVolumeControl,
  type TVolumeKey
} from '@/components/voice-provider/volume-control-context';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import {
  ExternalLink,
  Maximize2,
  Minimize2,
  Monitor,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut
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
import { CardGradient } from './card-gradient';
import { useScreenShareZoom } from './hooks/use-screen-share-zoom';
import { useVoiceRefs } from './hooks/use-voice-refs';
import { PinButton } from './pin-button';
import { PopoutWindow } from './popout-window';
import { VolumeButton } from './volume-button';

type tScreenShareControlsProps = {
  isPinned: boolean;
  isZoomEnabled: boolean;
  handlePinToggle: () => void;
  handleTogglePopout: () => void;
  handleToggleZoom: () => void;
  handleToggleFullscreen: () => void;
  showPinControls: boolean;
  showAudioControl: boolean;
  volumeKey: TVolumeKey;
  isFullscreen: boolean;
  isPoppedOut: boolean;
};

const ScreenShareControls = memo(
  ({
    isPinned,
    isZoomEnabled,
    handlePinToggle,
    handleTogglePopout,
    handleToggleZoom,
    handleToggleFullscreen,
    showPinControls,
    showAudioControl,
    volumeKey,
    isFullscreen,
    isPoppedOut
  }: tScreenShareControlsProps) => {
    return (
      <CardControls>
        {showAudioControl && <VolumeButton volumeKey={volumeKey} />}
        <IconButton
          variant={isPoppedOut ? 'default' : 'ghost'}
          icon={ExternalLink}
          onClick={handleTogglePopout}
          title={isPoppedOut ? 'Return to In-App' : 'Pop Out Stream'}
          size="sm"
        />
        <IconButton
          variant={isFullscreen ? 'default' : 'ghost'}
          icon={isFullscreen ? Minimize2 : Maximize2}
          onClick={handleToggleFullscreen}
          title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          size="sm"
        />
        {showPinControls && isPinned && (
          <IconButton
            variant={isZoomEnabled ? 'default' : 'ghost'}
            icon={isZoomEnabled ? ZoomOut : ZoomIn}
            onClick={handleToggleZoom}
            title={isZoomEnabled ? 'Disable Zoom' : 'Enable Zoom'}
            size="sm"
          />
        )}
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
};

const POPOUT_CONTROLS_IDLE_HIDE_MS = 2500;

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
      isZoomEnabled,
      zoom,
      position,
      isDragging,
      handleToggleZoom,
      handleWheel,
      handleMouseDown,
      handleMouseMove,
      handleMouseUp,
      getCursor,
      resetZoom
    } = useScreenShareZoom();
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isPoppedOut, setIsPoppedOut] = useState(false);
    const [isPopoutFullscreen, setIsPopoutFullscreen] = useState(false);
    const [showPopoutWindowControls, setShowPopoutWindowControls] = useState(true);
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
      setIsPoppedOut((prev) => !prev);
    }, []);

    const handleClosePopout = useCallback(() => {
      setIsPoppedOut(false);
    }, []);

    const handlePopoutBlocked = useCallback(() => {
      toast.error('Pop-out was blocked. Allow pop-ups and try again.');
      setIsPoppedOut(false);
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

    const handlePopoutVolumeChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        setVolume(volumeKey, Number(e.target.value));
      },
      [setVolume, volumeKey]
    );

    const handlePopoutMuteToggle = useCallback(() => {
      toggleMute(volumeKey);
    }, [toggleMute, volumeKey]);

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
        document.removeEventListener('fullscreenchange', handleFullscreenChange);
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
    }, [clearPopoutControlsHideTimeout, isPoppedOut, revealPopoutWindowControls]);

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
    }, [hasScreenShareStream]);

    if (!user || !hasScreenShareStream) return null;

    return (
      <>
        <div
          ref={containerRef}
          className={cn(
            'relative bg-card rounded-lg overflow-hidden group',
            'flex items-center justify-center',
            'w-full h-full',
            'border border-border',
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
          <CardGradient />

          <ScreenShareControls
            isPinned={isPinned}
            isZoomEnabled={isZoomEnabled}
            handlePinToggle={handlePinToggle}
            handleTogglePopout={handleTogglePopout}
            handleToggleZoom={handleToggleZoom}
            handleToggleFullscreen={handleToggleFullscreen}
            showPinControls={showPinControls}
            showAudioControl={!isOwnUser && hasScreenShareAudioStream && !isPoppedOut}
            volumeKey={volumeKey}
            isFullscreen={isFullscreen}
            isPoppedOut={isPoppedOut}
          />

          <video
            ref={screenShareRef}
            autoPlay
            muted={isOwnUser || isPoppedOut}
            playsInline
            className={cn(
              'absolute inset-0 w-full h-full object-contain bg-black',
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
                <p className="text-xs text-white/70">Opened in a pop-out window</p>
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

          <div className="absolute bottom-0 left-0 right-0 p-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="flex items-center gap-2 min-w-0">
              <Monitor className="size-3.5 text-purple-400 flex-shrink-0" />
              <span className="text-white font-medium text-xs truncate">
                {user.name}'s screen
              </span>
              {isPoppedOut && (
                <span className="text-white/70 text-xs ml-auto flex-shrink-0">
                  Popped out
                </span>
              )}
              {!isPoppedOut && isZoomEnabled && zoom > 1 && (
                <span className="text-white/70 text-xs ml-auto flex-shrink-0">
                  {Math.round(zoom * 100)}%
                </span>
              )}
            </div>
          </div>
        </div>

        <PopoutWindow
          isOpen={isPoppedOut}
          windowName={popoutWindowName}
          title={`${user.name}'s screen - Sharkord`}
          onClose={handleClosePopout}
          onBlocked={handlePopoutBlocked}
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
            <div
              style={{
                position: 'absolute',
                top: '12px',
                right: '12px',
                zIndex: 20,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                opacity: showPopoutWindowControls ? 1 : 0,
                pointerEvents: showPopoutWindowControls ? 'auto' : 'none',
                transition: 'opacity 140ms ease'
              }}
            >
              <button
                type="button"
                onClick={handleTogglePopoutFullscreen}
                title={isPopoutFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
                aria-label={
                  isPopoutFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'
                }
                style={{
                  border: '1px solid rgba(255, 255, 255, 0.55)',
                  background: 'rgba(15, 23, 42, 0.88)',
                  color: '#ffffff',
                  borderRadius: '10px',
                  width: '40px',
                  height: '40px',
                  padding: '0',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
                  cursor: 'pointer'
                }}
              >
                {isPopoutFullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
              </button>
            </div>

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
                  objectFit: 'contain',
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

              {!isOwnUser && hasScreenShareAudioStream && (
                <div
                  style={{
                    position: 'absolute',
                    left: '12px',
                    bottom: '12px',
                    zIndex: 20,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    background: 'rgba(0, 0, 0, 0.55)',
                    borderRadius: '8px',
                    padding: '6px 8px'
                  }}
                >
                  <button
                    type="button"
                    onClick={handlePopoutMuteToggle}
                    style={{
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      background: 'transparent',
                      color: '#ffffff',
                      borderRadius: '6px',
                      padding: '4px 8px',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                    {isMuted ? 'Unmute' : 'Mute'}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={volume}
                    onChange={handlePopoutVolumeChange}
                    style={{ width: '120px', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '12px', opacity: 0.8 }}>{volume}%</span>
                </div>
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
