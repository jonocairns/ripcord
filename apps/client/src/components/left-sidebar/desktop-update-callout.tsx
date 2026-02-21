import { getDesktopBridge } from '@/runtime/desktop-bridge';
import type { TDesktopUpdateStatus } from '@/runtime/types';
import { AlertTriangle, Download, Loader2, Rocket } from 'lucide-react';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';

const MANUAL_UPDATE_URL = 'https://github.com/jonocairns/ripcord/releases';

type TCalloutContent = {
  title: string;
  description: string;
  icon: ReactNode;
  toneClassName: string;
  pulseTitleClassName?: string;
};

const resolveCalloutContent = (
  status: TDesktopUpdateStatus
): TCalloutContent | undefined => {
  if (status.state === 'available') {
    return {
      title: 'Update available',
      description: status.availableVersion
        ? `Version ${status.availableVersion} is downloading in the background.`
        : 'A new version is downloading in the background.',
      icon: <Download className="h-4 w-4 text-amber-500" />,
      toneClassName: 'bg-card'
    };
  }

  if (status.state === 'downloading') {
    const progressText =
      typeof status.percent === 'number' ? `${Math.round(status.percent)}%` : '';

    return {
      title: 'Downloading update',
      description: progressText
        ? `Update download in progress (${progressText}).`
        : 'Update download in progress.',
      icon: <Loader2 className="h-4 w-4 animate-spin text-amber-500" />,
      toneClassName: 'bg-card'
    };
  }

  if (status.state === 'downloaded') {
    return {
      title: 'Update ready',
      description: status.availableVersion
        ? `Version ${status.availableVersion} is ready to install.`
        : 'A new version is ready to install.',
      icon: <Rocket className="h-4 w-4 text-emerald-500" />,
      toneClassName: 'bg-card',
      pulseTitleClassName: 'animate-pulse'
    };
  }

  if (status.state === 'error' && status.message) {
    if (status.manualInstallRequired) {
      return {
        title: 'Install update manually',
        description: status.availableVersion
          ? `Version ${status.availableVersion} is available. Automatic install wasn't available on this machine.`
          : "Automatic install wasn't available on this machine.",
        icon: <Download className="h-4 w-4 text-amber-500" />,
        toneClassName: 'bg-card'
      };
    }

    return {
      title: 'Update unavailable',
      description: status.message,
      icon: <AlertTriangle className="h-4 w-4 text-red-500" />,
      toneClassName: 'bg-card'
    };
  }

  return undefined;
};

const DesktopUpdateCallout = memo(() => {
  const desktopBridge = getDesktopBridge();
  const [status, setStatus] = useState<TDesktopUpdateStatus | undefined>();
  const [installingUpdate, setInstallingUpdate] = useState(false);

  useEffect(() => {
    if (!desktopBridge) {
      return;
    }

    let disposed = false;

    void desktopBridge
      .getUpdateStatus()
      .then((nextStatus) => {
        if (disposed) {
          return;
        }

        setStatus(nextStatus);
      })
      .catch(() => {
        // ignore transient bootstrap errors
      });

    const unsubscribe = desktopBridge.subscribeUpdateStatus((nextStatus) => {
      if (disposed) {
        return;
      }

      setStatus(nextStatus);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [desktopBridge]);

  const handleInstallUpdate = useCallback(async () => {
    if (status?.state !== 'downloaded') {
      return;
    }

    if (!desktopBridge) {
      return;
    }

    setInstallingUpdate(true);

    try {
      const started = await desktopBridge.installUpdateAndRestart();

      if (!started) {
        toast.error('Update is not ready to install yet.');
        return;
      }

      toast.success('Installing update and restarting app...');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to start update install';
      toast.error(message);
    } finally {
      setInstallingUpdate(false);
    }
  }, [desktopBridge, status?.state]);

  const calloutContent = useMemo(() => {
    if (!status) {
      return undefined;
    }

    return resolveCalloutContent(status);
  }, [status]);

  const handleOpenManualInstall = useCallback(() => {
    window.open(MANUAL_UPDATE_URL, '_blank', 'noopener,noreferrer');
  }, []);

  if (!status || !calloutContent) {
    return null;
  }

  return (
    <div className="relative border-t border-border px-2 py-2 bg-card">
      <div className={`rounded-md p-2 ${calloutContent.toneClassName}`}>
        <div className="flex items-center gap-2">
          {calloutContent.icon}
          <div className="min-w-0">
            <p
              className={`text-xs font-semibold text-foreground ${calloutContent.pulseTitleClassName || ''}`}
            >
              {calloutContent.title}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground leading-snug">
              {calloutContent.description}
            </p>
          </div>
        </div>

        {status.state === 'downloaded' && (
          <Button
            size="sm"
            className="mt-2 w-full"
            onClick={handleInstallUpdate}
            disabled={installingUpdate}
          >
            {installingUpdate ? 'Restarting...' : 'Restart to Update'}
          </Button>
        )}

        {status.state === 'error' && status.manualInstallRequired && (
          <Button
            size="sm"
            variant="outline"
            className="mt-2 w-full"
            onClick={handleOpenManualInstall}
          >
            Open Releases
          </Button>
        )}
      </div>
    </div>
  );
});

export { DesktopUpdateCallout };
