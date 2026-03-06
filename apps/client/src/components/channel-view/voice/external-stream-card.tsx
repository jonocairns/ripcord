import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { IconButton } from '@/components/ui/icon-button';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { cn } from '@/lib/utils';
import type { TExternalStream } from '@sharkord/shared';
import {
  ExternalLink,
  EyeOff,
  Headphones,
  Maximize2,
  Minimize2,
  Router,
  Video,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CardControls } from './card-controls';
import { CardGradient } from './card-gradient';
import { useScreenShareZoom } from './hooks/use-screen-share-zoom';
import { useVoiceRefs } from './hooks/use-voice-refs';
import { PinButton } from './pin-button';
import { DEFAULT_WINDOW_FEATURES, PopoutWindow } from './popout-window';
import { StreamSettingsPopover } from './stream-settings-popover';

type TExternalStreamControlsProps = {
  isPinned: boolean;
  isZoomEnabled: boolean;
  isFullscreen: boolean;
  isPoppedOut: boolean;
  handlePinToggle: () => void;
  handleTogglePopout: () => void;
  handleToggleZoom: () => void;
  handleToggleFullscreen: () => void;
  showPinControls: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
  volume: number;
  isMuted: boolean;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  onStopWatching?: () => void;
};

const ExternalStreamControls = memo(
  ({
    isPinned,
    isZoomEnabled,
    isFullscreen,
    isPoppedOut,
    handlePinToggle,
    handleTogglePopout,
    handleToggleZoom,
    handleToggleFullscreen,
    showPinControls,
    hasVideo,
    hasAudio,
    volume,
    isMuted,
    onVolumeChange,
    onMuteToggle,
    onStopWatching
  }: TExternalStreamControlsProps) => {
    return (
      <CardControls>
        {onStopWatching && (
          <IconButton
            variant="ghost"
            icon={EyeOff}
            onClick={onStopWatching}
            title="Stop Watching"
            size="sm"
          />
        )}
        {hasAudio && (
          <StreamSettingsPopover
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={onVolumeChange}
            onMuteToggle={onMuteToggle}
          />
        )}
        {hasVideo && (
          <IconButton
            variant={isPoppedOut ? 'default' : 'ghost'}
            icon={ExternalLink}
            onClick={handleTogglePopout}
            title={isPoppedOut ? 'Return to In-App' : 'Pop Out Stream'}
            size="sm"
          />
        )}
        {hasVideo && (
          <IconButton
            variant={isFullscreen ? 'default' : 'ghost'}
            icon={isFullscreen ? Minimize2 : Maximize2}
            onClick={handleToggleFullscreen}
            title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
            size="sm"
          />
        )}
        {showPinControls && hasVideo && isPinned && (
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

type TExternalStreamCardProps = {
  streamId: number;
  stream: TExternalStream;
  isPinned?: boolean;
  onPin: () => void;
  onUnpin: () => void;
  className?: string;
  showPinControls: boolean;
  onStopWatching?: () => void;
};

const ExternalStreamCard = memo(
  ({
    streamId,
    stream,
    isPinned = false,
    onPin,
    onUnpin,
    className,
    showPinControls = true,
    onStopWatching
  }: TExternalStreamCardProps) => {
    const {
      externalVideoRef,
      externalAudioRef,
      hasExternalVideoStream,
      hasExternalAudioStream,
      externalVideoStream,
      externalAudioStream
    } = useVoiceRefs(streamId, stream.pluginId, stream.key);

    const { getVolume, setVolume, toggleMute, getExternalVolumeKey } =
      useVolumeControl();

    const volumeKey = getExternalVolumeKey(stream.pluginId, stream.key);
    const volume = getVolume(volumeKey);
    const isMuted = volume === 0;

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
    const [popoutWindow, setPopoutWindow] = useState<Window | null>(null);
    const [popoutVideoElement, setPopoutVideoElement] =
      useState<HTMLVideoElement | null>(null);
    const [popoutAudioElement, setPopoutAudioElement] =
      useState<HTMLAudioElement | null>(null);
    const [isPopoutFullscreen, setIsPopoutFullscreen] = useState(false);
    const popoutWindowName = useMemo(
      () => `external-stream-${streamId}`,
      [streamId]
    );

    const handlePinToggle = useCallback(() => {
      if (isPinned) {
        onUnpin?.();
        resetZoom();
      } else {
        onPin?.();
      }
    }, [isPinned, onPin, onUnpin, resetZoom]);

    const handleVolumeChange = useCallback(
      (newVolume: number) => {
        setVolume(volumeKey, newVolume);
      },
      [volumeKey, setVolume]
    );

    const handleMuteToggle = useCallback(() => {
      toggleMute(volumeKey);
    }, [volumeKey, toggleMute]);
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

      if (!container) {
        return;
      }

      if (document.fullscreenElement === container) {
        void document.exitFullscreen();
      } else {
        void container.requestFullscreen();
      }
    }, [containerRef]);

    const handleTogglePopoutFullscreen = useCallback(() => {
      const popoutDocument = popoutVideoElement?.ownerDocument;

      if (!popoutDocument) {
        return;
      }

      if (popoutDocument.fullscreenElement) {
        void popoutDocument.exitFullscreen();
        return;
      }

      void popoutDocument.documentElement.requestFullscreen();
    }, [popoutVideoElement]);

    const hasVideo = stream.tracks?.video && hasExternalVideoStream;
    const hasAudio = stream.tracks?.audio && hasExternalAudioStream;

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
      if (hasVideo) {
        return;
      }

      setIsPoppedOut(false);
      setPopoutWindow(null);
    }, [hasVideo]);

    useEffect(() => {
      if (!externalAudioRef.current) {
        return;
      }

      externalAudioRef.current.muted = isPoppedOut;
    }, [externalAudioRef, isPoppedOut]);

    useEffect(() => {
      if (!isPoppedOut || !popoutVideoElement) {
        return;
      }

      if (popoutVideoElement.srcObject !== externalVideoStream) {
        popoutVideoElement.srcObject = externalVideoStream ?? null;
      }
    }, [externalVideoStream, isPoppedOut, popoutVideoElement]);

    useEffect(() => {
      if (!isPoppedOut || !popoutAudioElement) {
        return;
      }

      if (popoutAudioElement.srcObject !== externalAudioStream) {
        popoutAudioElement.srcObject = externalAudioStream ?? null;
      }

      popoutAudioElement.volume = volume / 100;
      popoutAudioElement.muted = isMuted;
    }, [externalAudioStream, isMuted, isPoppedOut, popoutAudioElement, volume]);

    useEffect(() => {
      if (!isPoppedOut || !popoutVideoElement) {
        return;
      }

      const popoutDocument = popoutVideoElement.ownerDocument;

      const handlePopoutFullscreenChange = () => {
        setIsPopoutFullscreen(!!popoutDocument.fullscreenElement);
      };

      popoutDocument.addEventListener(
        'fullscreenchange',
        handlePopoutFullscreenChange
      );
      handlePopoutFullscreenChange();

      return () => {
        popoutDocument.removeEventListener(
          'fullscreenchange',
          handlePopoutFullscreenChange
        );
      };
    }, [isPoppedOut, popoutVideoElement]);

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
          onWheel={hasVideo && !isPoppedOut ? handleWheel : undefined}
          onMouseDown={hasVideo && !isPoppedOut ? handleMouseDown : undefined}
          onMouseMove={hasVideo && !isPoppedOut ? handleMouseMove : undefined}
          onMouseUp={hasVideo && !isPoppedOut ? handleMouseUp : undefined}
          onMouseLeave={hasVideo && !isPoppedOut ? handleMouseUp : undefined}
          style={{
            cursor: hasVideo && !isPoppedOut ? getCursor() : 'default'
          }}
        >
          <CardGradient />

          <ExternalStreamControls
            isPinned={isPinned}
            isZoomEnabled={isZoomEnabled}
            isFullscreen={isFullscreen}
            isPoppedOut={isPoppedOut}
            handlePinToggle={handlePinToggle}
            handleTogglePopout={handleTogglePopout}
            handleToggleZoom={handleToggleZoom}
            handleToggleFullscreen={handleToggleFullscreen}
            showPinControls={showPinControls}
            hasVideo={!!hasVideo}
            hasAudio={!!hasAudio}
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={handleVolumeChange}
            onMuteToggle={handleMuteToggle}
            onStopWatching={onStopWatching}
          />

          {hasVideo ? (
            <video
              ref={externalVideoRef}
              autoPlay
              muted
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
          ) : (
            <div className="flex flex-col items-center justify-center gap-4 p-8">
              <div className="relative">
                {stream.avatarUrl ? (
                  <Avatar className="w-20 h-20 border-2 border-green-500/50">
                    <AvatarImage
                      src={stream.avatarUrl}
                      alt={stream.title || 'External Stream'}
                    />
                    <AvatarFallback className="bg-gradient-to-br from-green-500/30 to-emerald-500/30">
                      <Headphones className="size-10 text-green-400" />
                    </AvatarFallback>
                  </Avatar>
                ) : (
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-green-500/30 to-emerald-500/30 flex items-center justify-center border-2 border-green-500/50">
                    <Headphones className="size-10 text-green-400" />
                  </div>
                )}
                {hasAudio && !isMuted && (
                  <div className="absolute inset-0 rounded-full animate-pulse bg-green-500/20" />
                )}
              </div>
            </div>
          )}

          {hasAudio && (
            <audio ref={externalAudioRef} autoPlay className="hidden" />
          )}

          {isPoppedOut && hasVideo && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/85 text-white p-4 text-center">
              <Video className="size-8 text-blue-400" />
              <div className="space-y-1">
                <p className="text-sm font-semibold">
                  {stream.title || 'External Stream'}
                </p>
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

          <div className="absolute bottom-0 left-0 right-0 p-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="flex items-center gap-2 min-w-0">
              {stream.avatarUrl ? (
                <img
                  src={stream.avatarUrl}
                  alt={stream.title || 'External Stream'}
                  className="h-5 flex-shrink-0 rounded-full"
                />
              ) : (
                <Router className="size-3.5 text-purple-400 flex-shrink-0" />
              )}
              <span className="text-white font-medium text-xs truncate">
                {stream.title || 'External Stream'}
              </span>

              <div className="flex items-center gap-1 ml-auto">
                {hasVideo && <Video className="size-3 text-blue-400" />}
                {hasAudio && (
                  <Headphones
                    className={cn(
                      'size-3',
                      isMuted ? 'text-red-400' : 'text-green-400'
                    )}
                  />
                )}
              </div>

              {stream.pluginId && (
                <span className="text-white/50 text-[10px] flex-shrink-0">
                  via {stream.pluginId}
                </span>
              )}

              {isPoppedOut && (
                <span className="text-white/70 text-xs flex-shrink-0">
                  Popped out
                </span>
              )}

              {!isPoppedOut && isZoomEnabled && zoom > 1 && (
                <span className="text-white/70 text-xs flex-shrink-0">
                  {Math.round(zoom * 100)}%
                </span>
              )}
            </div>
          </div>
        </div>

        <PopoutWindow
          isOpen={isPoppedOut && !!hasVideo}
          windowName={popoutWindowName}
          title={`${stream.title || 'External Stream'} - Sharkord`}
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
            <div
              style={{
                position: 'absolute',
                top: '12px',
                right: '12px',
                zIndex: 20,
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              <button
                type="button"
                onClick={handleTogglePopoutFullscreen}
                title={
                  isPopoutFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'
                }
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
                {isPopoutFullscreen ? (
                  <Minimize2 size={20} />
                ) : (
                  <Maximize2 size={20} />
                )}
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
                  objectFit: 'cover',
                  backgroundColor: '#000000'
                }}
              />
              {hasAudio && (
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

ExternalStreamCard.displayName = 'ExternalStreamCard';

export { ExternalStreamCard };
