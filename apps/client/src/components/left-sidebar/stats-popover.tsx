import { useVoice } from '@/features/server/voice/hooks';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import type { TAppAudioEndReason } from '@/runtime/types';
import { filesize } from 'filesize';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

type StatsPopoverProps = {
  children: React.ReactNode;
};

type TAppAudioDebugState = {
  sessionId?: string;
  targetId?: string;
  frameRate: number;
  totalFrames: number;
  droppedFrames: number;
  lastFrameAtMs?: number;
  lastStatusReason?: TAppAudioEndReason;
  lastStatusError?: string;
};

const INITIAL_APP_AUDIO_DEBUG_STATE: TAppAudioDebugState = {
  frameRate: 0,
  totalFrames: 0,
  droppedFrames: 0
};

const StatsPopover = memo(({ children }: StatsPopoverProps) => {
  const { transportStats } = useVoice();
  const [desktopBridgeAvailable] = useState(() => !!getDesktopBridge());
  const [appAudioDebug, setAppAudioDebug] = useState<TAppAudioDebugState>(
    INITIAL_APP_AUDIO_DEBUG_STATE
  );
  const appAudioDebugRef = useRef<
    TAppAudioDebugState & {
      framesSinceTick: number;
      lastTickMs: number;
    }
  >({
    ...INITIAL_APP_AUDIO_DEBUG_STATE,
    framesSinceTick: 0,
    lastTickMs: Date.now()
  });

  const {
    producer,
    consumer,
    totalBytesSent,
    totalBytesReceived,
    currentBitrateSent,
    currentBitrateReceived
  } = transportStats;
  const lastFrameAgeMs = useMemo(() => {
    if (!appAudioDebug.lastFrameAtMs) {
      return undefined;
    }

    return Math.max(0, Date.now() - appAudioDebug.lastFrameAtMs);
  }, [appAudioDebug.lastFrameAtMs]);

  useEffect(() => {
    const desktopBridge = getDesktopBridge();

    if (!desktopBridge) {
      return;
    }

    const removeFrameSubscription = desktopBridge.subscribeAppAudioFrames(
      (frame) => {
        const debugState = appAudioDebugRef.current;
        debugState.sessionId = frame.sessionId;
        debugState.targetId = frame.targetId;
        debugState.totalFrames += 1;
        debugState.framesSinceTick += 1;
        debugState.lastFrameAtMs = Date.now();
        debugState.lastStatusReason = undefined;

        if (frame.droppedFrameCount && frame.droppedFrameCount > 0) {
          debugState.droppedFrames += frame.droppedFrameCount;
        }
      }
    );

    const removeStatusSubscription = desktopBridge.subscribeAppAudioStatus(
      (statusEvent) => {
        const debugState = appAudioDebugRef.current;

        if (
          debugState.sessionId &&
          statusEvent.sessionId &&
          statusEvent.sessionId !== debugState.sessionId
        ) {
          return;
        }

        debugState.lastStatusReason = statusEvent.reason;
        debugState.lastStatusError = statusEvent.error;
        if (statusEvent.targetId) {
          debugState.targetId = statusEvent.targetId;
        }
      }
    );

    const interval = window.setInterval(() => {
      const debugState = appAudioDebugRef.current;
      const now = Date.now();
      const elapsedMs = Math.max(1, now - debugState.lastTickMs);
      const frameRate = (debugState.framesSinceTick * 1000) / elapsedMs;

      debugState.frameRate = frameRate;
      debugState.framesSinceTick = 0;
      debugState.lastTickMs = now;

      const nextState: TAppAudioDebugState = {
        sessionId: debugState.sessionId,
        targetId: debugState.targetId,
        frameRate: debugState.frameRate,
        totalFrames: debugState.totalFrames,
        droppedFrames: debugState.droppedFrames,
        lastFrameAtMs: debugState.lastFrameAtMs,
        lastStatusReason: debugState.lastStatusReason,
        lastStatusError: debugState.lastStatusError
      };

      setAppAudioDebug((currentState) => {
        if (
          currentState.sessionId === nextState.sessionId &&
          currentState.targetId === nextState.targetId &&
          currentState.frameRate === nextState.frameRate &&
          currentState.totalFrames === nextState.totalFrames &&
          currentState.droppedFrames === nextState.droppedFrames &&
          currentState.lastFrameAtMs === nextState.lastFrameAtMs &&
          currentState.lastStatusReason === nextState.lastStatusReason &&
          currentState.lastStatusError === nextState.lastStatusError
        ) {
          return currentState;
        }

        return nextState;
      });
    }, 500);

    return () => {
      window.clearInterval(interval);
      removeFrameSubscription();
      removeStatusSubscription();
    };
  }, []);

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="p-0">
        <div className="w-72 p-3 text-xs">
          <h3 className="font-semibold text-sm mb-2 text-foreground">
            Transport Statistics
          </h3>
          <div className="grid grid-cols-2 gap-4 mb-3">
            <div>
              <h4 className="font-medium text-green-400 mb-1">Outgoing</h4>
              {producer ? (
                <div className="space-y-1 text-muted-foreground">
                  <div>Rate: {filesize(currentBitrateSent)}/s</div>
                  <div>Packets: {producer.packetsSent}</div>
                  <div>RTT: {producer.rtt.toFixed(1)} ms</div>
                </div>
              ) : (
                <div className="text-muted-foreground">No data</div>
              )}
            </div>

            <div>
              <h4 className="font-medium text-blue-400 mb-1">Incoming</h4>
              {consumer ? (
                <div className="space-y-1 text-muted-foreground">
                  <div>Rate: {filesize(currentBitrateReceived)}/s</div>
                  <div>Packets: {consumer.packetsReceived}</div>
                  {consumer.packetsLost > 0 && (
                    <div className="text-red-400">
                      Lost: {consumer.packetsLost}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-muted-foreground">No remote streams</div>
              )}
            </div>
          </div>
          <div className="border-t border-border/50 pt-2">
            <h4 className="font-medium text-yellow-400 mb-1">Session Totals</h4>
            <div className="grid grid-cols-2 gap-2 text-muted-foreground">
              <div>↑ {filesize(totalBytesSent)}</div>
              <div>↓ {filesize(totalBytesReceived)}</div>
            </div>
          </div>
          <div className="border-t border-border/50 pt-2 mt-2">
            <h4 className="font-medium text-cyan-400 mb-1">Per-App Audio Debug</h4>
            <div className="space-y-1 text-muted-foreground">
              <div>Desktop bridge: {desktopBridgeAvailable ? 'available' : 'unavailable'}</div>
              <div>Target: {appAudioDebug.targetId || 'unknown'}</div>
              <div>Frames: {appAudioDebug.totalFrames}</div>
              <div>Rate: {appAudioDebug.frameRate.toFixed(1)} fps</div>
              <div>Dropped: {appAudioDebug.droppedFrames}</div>
              <div>
                Last frame:{' '}
                {lastFrameAgeMs !== undefined ? `${lastFrameAgeMs} ms ago` : 'n/a'}
              </div>
              <div>Status: {appAudioDebug.lastStatusReason || 'no end event seen'}</div>
              {appAudioDebug.lastStatusError && (
                <div className="text-amber-300 break-all">
                  Error: {appAudioDebug.lastStatusError}
                </div>
              )}
              {appAudioDebug.totalFrames === 0 && (
                <div>No per-app audio frames seen yet.</div>
              )}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
});

export { StatsPopover };
