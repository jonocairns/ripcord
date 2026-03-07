import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { IconButton } from '@/components/ui/icon-button';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { cn } from '@/lib/utils';
import type { TExternalStream, TIptvStatus } from '@sharkord/shared';
import {
  ExternalLink,
  EyeOff,
  Headphones,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Router,
  Video,
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
    const controlButtonClassName =
      'h-10 w-10 rounded-[10px] border border-white/55 bg-slate-950/88 text-white shadow-[0_6px_18px_rgba(0,0,0,0.45)] backdrop-blur-sm hover:bg-slate-900/95 hover:text-white';
    const activeControlButtonClassName =
      'h-10 w-10 rounded-[10px] border border-white/55 bg-slate-800/95 text-white shadow-[0_6px_18px_rgba(0,0,0,0.45)] backdrop-blur-sm hover:bg-slate-700 hover:text-white';

    return (
      <CardControls className="top-3 right-3 gap-2">
        {onStopWatching && (
          <IconButton
            variant="ghost"
            icon={EyeOff}
            onClick={onStopWatching}
            title="Stop Watching"
            size="default"
            className={controlButtonClassName}
          />
        )}
        {hasAudio && (
          <StreamSettingsPopover
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={onVolumeChange}
            onMuteToggle={onMuteToggle}
            buttonSize="default"
            buttonClassName={controlButtonClassName}
          />
        )}
        {hasVideo && (
          <IconButton
            variant={isPoppedOut ? 'default' : 'ghost'}
            icon={ExternalLink}
            onClick={handleTogglePopout}
            title={isPoppedOut ? 'Return to In-App' : 'Pop Out Stream'}
            size="default"
            className={
              isPoppedOut
                ? activeControlButtonClassName
                : controlButtonClassName
            }
          />
        )}
        {hasVideo && (
          <IconButton
            variant={isFullscreen ? 'default' : 'ghost'}
            icon={isFullscreen ? Minimize2 : Maximize2}
            onClick={handleToggleFullscreen}
            title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
            size="default"
            className={
              isFullscreen
                ? activeControlButtonClassName
                : controlButtonClassName
            }
          />
        )}
        {showPinControls && hasVideo && isPinned && (
          <IconButton
            variant={isZoomEnabled ? 'default' : 'ghost'}
            icon={isZoomEnabled ? ZoomOut : ZoomIn}
            onClick={handleToggleZoom}
            title={isZoomEnabled ? 'Disable Zoom' : 'Enable Zoom'}
            size="default"
            className={
              isZoomEnabled
                ? activeControlButtonClassName
                : controlButtonClassName
            }
          />
        )}
        {showPinControls && (
          <PinButton
            isPinned={isPinned}
            handlePinToggle={handlePinToggle}
            size="default"
            className={
              isPinned ? activeControlButtonClassName : controlButtonClassName
            }
          />
        )}
      </CardControls>
    );
  }
);

type TExternalStreamCardProps = {
  streamId: number;
  stream: TExternalStream;
  iptvStatus?: TIptvStatus;
  isPinned?: boolean;
  onPin: () => void;
  onUnpin: () => void;
  className?: string;
  showPinControls: boolean;
  onStopWatching?: () => void;
};

const POPOUT_CONTROLS_IDLE_HIDE_MS = 2500;

const ExternalStreamCard = memo(
  ({
    streamId,
    stream,
    iptvStatus,
    isPinned = false,
    onPin,
    onUnpin,
    className,
    showPinControls = true,
    onStopWatching
  }: TExternalStreamCardProps) => {
    const isIptvStream = iptvStatus !== undefined;
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
    const [isPopoutFullscreen, setIsPopoutFullscreen] = useState(false);
    const [isPopoutAudioEnabled, setIsPopoutAudioEnabled] = useState(false);
    const [hasVideoPlaybackStarted, setHasVideoPlaybackStarted] =
      useState(false);
    const [hasAudioPlaybackStarted, setHasAudioPlaybackStarted] =
      useState(false);
    const [showPopoutWindowControls, setShowPopoutWindowControls] =
      useState(true);
    const hidePopoutWindowControlsTimeoutRef = useRef<number | null>(null);
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
    const hasVideo = stream.tracks?.video && hasExternalVideoStream;
    const hasAudio = stream.tracks?.audio && hasExternalAudioStream;
    const hasIptvPlaybackStarted = hasVideo
      ? hasVideoPlaybackStarted
      : hasAudio && hasAudioPlaybackStarted;
    const showIptvLoadingState =
      isIptvStream &&
      iptvStatus.status !== 'error' &&
      ((iptvStatus.status === 'starting' && !hasIptvPlaybackStarted) ||
        (hasVideo && !hasVideoPlaybackStarted) ||
        (!hasVideo && hasAudio && !hasAudioPlaybackStarted));

    const enablePopoutAudio = useCallback(() => {
      if (!hasAudio) {
        return;
      }

      setIsPopoutAudioEnabled(true);

      if (!popoutVideoElement) {
        return;
      }

      popoutVideoElement.volume = volume / 100;
      popoutVideoElement.muted = isMuted;

      void popoutVideoElement.play().catch(() => {
        // Browsers can still reject playback in the pop-out window.
      });
    }, [hasAudio, isMuted, popoutVideoElement, volume]);

    const handlePopoutMuteToggle = useCallback(() => {
      enablePopoutAudio();
      toggleMute(volumeKey);
    }, [enablePopoutAudio, toggleMute, volumeKey]);

    const handlePopoutVolumeChange = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => {
        enablePopoutAudio();
        setVolume(volumeKey, Number(event.target.value));
      },
      [enablePopoutAudio, setVolume, volumeKey]
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
      setIsPopoutAudioEnabled(false);
      activePopoutWindow.focus();
    }, [isPoppedOut, popoutWindow, popoutWindowName]);

    const handleClosePopout = useCallback(() => {
      setIsPoppedOut(false);
      setIsPopoutAudioEnabled(false);
      setPopoutWindow(null);
    }, []);

    const handlePopoutBlocked = useCallback(() => {
      toast.error('Pop-out was blocked. Allow pop-ups and try again.');
      setIsPoppedOut(false);
      setIsPopoutAudioEnabled(false);
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

      setHasVideoPlaybackStarted(false);
      setIsPoppedOut(false);
      setIsPopoutAudioEnabled(false);
      clearPopoutControlsHideTimeout();
      setShowPopoutWindowControls(true);
      setPopoutWindow(null);
    }, [clearPopoutControlsHideTimeout, hasVideo]);

    useEffect(() => {
      if (hasAudio) {
        return;
      }

      setHasAudioPlaybackStarted(false);
      setIsPopoutAudioEnabled(false);
    }, [hasAudio]);

    useEffect(() => {
      if (!externalVideoStream) {
        setHasVideoPlaybackStarted(false);
        return;
      }

      if (
        externalVideoRef.current &&
        externalVideoRef.current.readyState >= 2
      ) {
        setHasVideoPlaybackStarted(true);
        return;
      }

      setHasVideoPlaybackStarted(false);
    }, [externalVideoRef, externalVideoStream]);

    useEffect(() => {
      if (!externalAudioStream) {
        setHasAudioPlaybackStarted(false);
        return;
      }

      if (
        externalAudioRef.current &&
        externalAudioRef.current.readyState >= 2
      ) {
        setHasAudioPlaybackStarted(true);
        return;
      }

      setHasAudioPlaybackStarted(false);
    }, [externalAudioRef, externalAudioStream]);

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
      if (!externalAudioRef.current) {
        return;
      }

      externalAudioRef.current.muted = isPoppedOut;
    }, [externalAudioRef, isPoppedOut]);

    useEffect(() => {
      if (!isPoppedOut || !popoutVideoElement) {
        return;
      }

      if (!externalVideoStream) {
        popoutVideoElement.srcObject = null;
        return;
      }

      const popoutStream = new MediaStream([
        ...externalVideoStream.getVideoTracks(),
        ...(externalAudioStream?.getAudioTracks() ?? [])
      ]);

      popoutVideoElement.srcObject = popoutStream;
      popoutVideoElement.muted =
        !externalAudioStream || isMuted || !isPopoutAudioEnabled;

      void popoutVideoElement.play().catch(() => {
        // Pop-out playback is user initiated, but browser media policies can
        // still reject autoplay. Keep the stream attached and fail silently.
      });
    }, [
      externalAudioStream,
      externalVideoStream,
      isMuted,
      isPopoutAudioEnabled,
      isPoppedOut,
      popoutVideoElement
    ]);

    useEffect(() => {
      if (!popoutVideoElement) {
        return;
      }

      popoutVideoElement.volume = volume / 100;
      popoutVideoElement.muted =
        !externalAudioStream || isMuted || !isPopoutAudioEnabled;
    }, [
      externalAudioStream,
      isMuted,
      isPopoutAudioEnabled,
      popoutVideoElement,
      volume
    ]);

    useEffect(() => {
      if (!isPoppedOut || !popoutVideoElement) {
        return;
      }

      const popoutDocument = popoutVideoElement.ownerDocument;
      const activePopoutWindow = popoutDocument.defaultView;

      if (!activePopoutWindow) {
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
      activePopoutWindow.addEventListener('focus', handlePopoutFocus);
      activePopoutWindow.addEventListener('blur', handlePopoutBlur);
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
        activePopoutWindow.removeEventListener('focus', handlePopoutFocus);
        activePopoutWindow.removeEventListener('blur', handlePopoutBlur);
      };
    }, [
      clearPopoutControlsHideTimeout,
      isPoppedOut,
      popoutVideoElement,
      revealPopoutWindowControls
    ]);

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

          {showIptvLoadingState && (
            <div className="absolute inset-0 z-[5] flex flex-col items-center justify-center gap-3 bg-black/72 px-6 text-center text-white">
              <LoaderCircle className="size-8 animate-spin text-amber-300" />
              <div className="space-y-1">
                <p className="text-sm font-semibold">
                  {iptvStatus.activeChannel?.name ||
                    stream.title ||
                    'Connecting IPTV stream'}
                </p>
                <p className="text-xs text-white/70">
                  Waiting for source stream...
                </p>
              </div>
            </div>
          )}

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
              onLoadedData={() => {
                setHasVideoPlaybackStarted(true);
              }}
              onCanPlay={() => {
                setHasVideoPlaybackStarted(true);
              }}
              onPlaying={() => {
                setHasVideoPlaybackStarted(true);
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
            <audio
              ref={externalAudioRef}
              autoPlay
              className="hidden"
              onLoadedData={() => {
                setHasAudioPlaybackStarted(true);
              }}
              onCanPlay={() => {
                setHasAudioPlaybackStarted(true);
              }}
              onPlaying={() => {
                setHasAudioPlaybackStarted(true);
              }}
            />
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
                gap: '8px',
                opacity: showPopoutWindowControls ? 1 : 0,
                pointerEvents: showPopoutWindowControls ? 'auto' : 'none',
                transition: 'opacity 140ms ease'
              }}
            >
              {hasAudio &&
                (isPopoutAudioEnabled ? (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      border: '1px solid rgba(255, 255, 255, 0.55)',
                      background: 'rgba(15, 23, 42, 0.88)',
                      borderRadius: '10px',
                      padding: '4px 8px',
                      boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)'
                    }}
                  >
                    <button
                      type="button"
                      onClick={handlePopoutMuteToggle}
                      title={
                        isMuted ? 'Unmute stream audio' : 'Mute stream audio'
                      }
                      aria-label={
                        isMuted ? 'Unmute stream audio' : 'Mute stream audio'
                      }
                      style={{
                        border: '1px solid rgba(255, 255, 255, 0.55)',
                        background: 'rgba(15, 23, 42, 0.88)',
                        color: '#ffffff',
                        borderRadius: '8px',
                        width: '32px',
                        height: '32px',
                        padding: '0',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                    >
                      {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={volume}
                      onChange={handlePopoutVolumeChange}
                      aria-label="Pop-out volume"
                      style={{ width: '96px', cursor: 'pointer' }}
                    />
                    <span
                      style={{
                        width: '34px',
                        textAlign: 'right',
                        fontSize: '12px',
                        opacity: 0.85
                      }}
                    >
                      {volume}%
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={enablePopoutAudio}
                    title="Enable stream audio"
                    aria-label="Enable stream audio"
                    style={{
                      border: '1px solid rgba(255, 255, 255, 0.55)',
                      background: 'rgba(15, 23, 42, 0.88)',
                      color: '#ffffff',
                      borderRadius: '10px',
                      height: '40px',
                      padding: '0 12px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
                      cursor: 'pointer'
                    }}
                  >
                    <Volume2 size={16} />
                    Enable Audio
                  </button>
                ))}

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
                muted={!hasAudio || isMuted || !isPopoutAudioEnabled}
                playsInline
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  backgroundColor: '#000000'
                }}
              />
            </div>
          </div>
        </PopoutWindow>
      </>
    );
  }
);

ExternalStreamCard.displayName = 'ExternalStreamCard';

export { ExternalStreamCard };
