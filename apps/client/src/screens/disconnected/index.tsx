import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { connect, setDisconnectInfo } from '@/features/server/actions';
import type { TDisconnectInfo } from '@/features/server/types';
import { getAuthToken, getRefreshToken } from '@/helpers/storage';
import {
  getRuntimeServerConfig,
  normalizeServerUrl,
  updateDesktopServerUrl
} from '@/runtime/server-config';
import { DisconnectCode } from '@sharkord/shared';
import { AlertCircle, Gavel, RefreshCw, WifiOff } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

type TDisconnectedProps = {
  info: TDisconnectInfo;
};

const RECONNECT_POLL_INTERVAL_MS = 5_000;

const Disconnected = memo(({ info }: TDisconnectedProps) => {
  const hasDesktopBridge =
    typeof window !== 'undefined' && Boolean(window.sharkordDesktop);
  const [reconnecting, setReconnecting] = useState(false);
  const [savingServerUrl, setSavingServerUrl] = useState(false);
  const reconnectingRef = useRef(false);
  const hasSavedAuth = Boolean(getAuthToken() || getRefreshToken());
  const [desktopServerUrl, setDesktopServerUrl] = useState(
    getRuntimeServerConfig().serverUrl
  );

  const disconnectType = useMemo(() => {
    const code = info.code;

    if (code === DisconnectCode.KICKED) {
      return {
        icon: <AlertCircle className="h-8 w-8 text-yellow-500" />,
        title: 'You have been kicked',
        message: info.reason || 'No reason provided.',
        canReconnect: true,
        autoReconnect: false
      };
    }

    if (code === DisconnectCode.BANNED) {
      return {
        icon: <Gavel className="h-8 w-8 text-red-500" />,
        title: 'You have been banned',
        message: info.reason || 'No reason provided.',
        canReconnect: false,
        autoReconnect: false
      };
    }

    return {
      icon: <WifiOff className="h-8 w-8 text-gray-500" />,
      title: 'Connection lost',
      message: 'Lost connection to the server unexpectedly.',
      canReconnect: true,
      autoReconnect: true
    };
  }, [info]);

  const attemptReconnect = useCallback(
    async (opts: { manual?: boolean } = {}) => {
      if (!hasSavedAuth) {
        if (opts.manual) {
          setDisconnectInfo(undefined);
        }

        return;
      }

      if (reconnectingRef.current) {
        return;
      }

      reconnectingRef.current = true;
      setReconnecting(true);

      try {
        await connect();
      } catch (error) {
        if (opts.manual) {
          const errorMessage =
            error instanceof Error ? error.message : 'Failed to reconnect';
          toast.error(`Reconnect failed: ${errorMessage}`);
        }
      } finally {
        reconnectingRef.current = false;
        setReconnecting(false);
      }
    },
    [hasSavedAuth]
  );

  useEffect(() => {
    if (!disconnectType.autoReconnect || !hasSavedAuth) {
      return;
    }

    void attemptReconnect();

    const intervalId = window.setInterval(() => {
      void attemptReconnect();
    }, RECONNECT_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [attemptReconnect, disconnectType.autoReconnect, hasSavedAuth]);

  const handleReconnect = useCallback(() => {
    void attemptReconnect({ manual: true });
  }, [attemptReconnect]);

  const onSaveServerUrl = useCallback(async () => {
    setSavingServerUrl(true);

    try {
      const normalized = normalizeServerUrl(desktopServerUrl);
      await updateDesktopServerUrl(normalized.url);
      toast.success('Desktop server URL saved');
      window.location.reload();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not save server URL';

      toast.error(message);
      setSavingServerUrl(false);
    }
  }, [desktopServerUrl]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="text-center space-y-6 max-w-md px-6">
        <div className="flex justify-center">{disconnectType.icon}</div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">
            {disconnectType.title}
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {disconnectType.message}
          </p>
          {disconnectType.autoReconnect && hasSavedAuth && (
            <p className="text-muted-foreground text-xs leading-relaxed">
              Trying to reconnect every 5 seconds.
            </p>
          )}
        </div>

        {disconnectType.canReconnect && (
          <Button
            onClick={handleReconnect}
            className="inline-flex items-center gap-2"
            disabled={reconnecting}
          >
            <RefreshCw
              className={reconnecting ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
            />
            {hasSavedAuth ? 'Reconnect' : 'Go to Connect Screen'}
          </Button>
        )}

        {hasDesktopBridge && (
          <div className="space-y-2 text-left">
            <p className="text-xs text-muted-foreground">
              Server might be down permanently. You can change the server URL.
            </p>
            <div className="flex gap-2">
              <Input
                value={desktopServerUrl}
                onChange={(event) => setDesktopServerUrl(event.target.value)}
                onEnter={onSaveServerUrl}
                placeholder="http://localhost:4991"
              />
              <Button
                variant="outline"
                onClick={onSaveServerUrl}
                disabled={!desktopServerUrl.trim() || savingServerUrl}
              >
                Save URL
              </Button>
            </div>
          </div>
        )}

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            Details
          </summary>
          <div className="mt-2 space-y-1">
            <div>Code: {info.code}</div>
            <div>Time: {info.time.toLocaleString()}</div>
          </div>
        </details>
      </div>
    </div>
  );
});

export { Disconnected };
