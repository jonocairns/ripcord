import { getDesktopBridge } from '@/runtime/desktop-bridge';
import type { TDesktopUpdateStatus } from '@/runtime/types';
import { Download } from 'lucide-react';
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState
} from 'react';
import { Button } from '../ui/button';

const MANUAL_UPDATE_BASE_URL = 'https://github.com/jonocairns/ripcord/releases';

const resolveManualUpdateUrl = (availableVersion?: string): string => {
  const normalizedVersion = availableVersion?.trim();
  if (!normalizedVersion) {
    return MANUAL_UPDATE_BASE_URL;
  }

  const versionWithoutTagPrefix = normalizedVersion.replace(/^v/i, '');
  if (!versionWithoutTagPrefix) {
    return MANUAL_UPDATE_BASE_URL;
  }

  const releaseTag = normalizedVersion.startsWith('v')
    ? normalizedVersion
    : `v${normalizedVersion}`;
  const installerFileName = `Ripcord.Desktop.Setup.${versionWithoutTagPrefix}.exe`;

  return `${MANUAL_UPDATE_BASE_URL}/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(installerFileName)}`;
};

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
  if (status.state === 'available' && status.manualInstallRequired) {
    return {
      title: 'Update available',
      description: status.availableVersion
        ? `Version ${status.availableVersion} is available to download.`
        : 'A new version is available to download.',
      icon: <Download className="h-4 w-4 text-emerald-500" />,
      toneClassName: 'bg-card',
      pulseTitleClassName: 'animate-pulse'
    };
  }

  return undefined;
};

const DesktopUpdateCallout = memo(() => {
  const desktopBridge = getDesktopBridge();
  const [status, setStatus] = useState<TDesktopUpdateStatus | undefined>();

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

  const calloutContent = useMemo(() => {
    if (!status) {
      return undefined;
    }

    return resolveCalloutContent(status);
  }, [status]);

  const manualInstallUrl = useMemo(
    () => resolveManualUpdateUrl(status?.availableVersion),
    [status?.availableVersion]
  );

  const handleOpenManualInstall = useCallback(() => {
    window.open(manualInstallUrl, '_blank', 'noopener,noreferrer');
  }, [manualInstallUrl]);

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
              className={`text-sm font-semibold text-foreground ${calloutContent.pulseTitleClassName || ''}`}
            >
              {calloutContent.title}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground leading-snug">
              {calloutContent.description}
            </p>
          </div>
        </div>

        <Button
          size="sm"
          className="mt-2 w-full"
          onClick={handleOpenManualInstall}
        >
          {status.availableVersion ? 'Download Installer' : 'Open Releases'}
        </Button>
      </div>
    </div>
  );
});

export { DesktopUpdateCallout };
