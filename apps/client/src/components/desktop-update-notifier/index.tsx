import { getDesktopBridge } from '@/runtime/desktop-bridge';
import type { TDesktopUpdateStatus } from '@/runtime/types';
import { memo, useEffect, useRef } from 'react';
import { toast } from 'sonner';

const READY_TOAST_ID = 'desktop-update-ready';
const AVAILABLE_TOAST_ID = 'desktop-update-available';
const ERROR_TOAST_ID = 'desktop-update-error';

const resolveVersionKey = (status: TDesktopUpdateStatus) => {
  return status.availableVersion || status.currentVersion;
};

const DesktopUpdateNotifier = memo(() => {
  const notifiedAvailableVersionsRef = useRef(new Set<string>());
  const notifiedDownloadedVersionsRef = useRef(new Set<string>());
  const prevStateRef = useRef<TDesktopUpdateStatus['state'] | undefined>(
    undefined
  );

  useEffect(() => {
    const desktopBridge = getDesktopBridge();

    if (!desktopBridge) {
      return;
    }

    let disposed = false;

    const installUpdate = () => {
      void desktopBridge
        .installUpdateAndRestart()
        .then((started) => {
          if (!started) {
            toast.error('Update is not ready to install yet.');
            return;
          }

          toast('Installing update and restarting app...');
        })
        .catch((error) => {
          const message =
            error instanceof Error
              ? error.message
              : 'Failed to start update install';
          toast.error(message);
        });
    };

    const handleStatus = (status: TDesktopUpdateStatus) => {
      if (disposed) {
        return;
      }

      const versionKey = resolveVersionKey(status);

      if (
        status.state === 'available' &&
        !notifiedAvailableVersionsRef.current.has(versionKey)
      ) {
        notifiedAvailableVersionsRef.current.add(versionKey);
        toast('Desktop update available', {
          id: AVAILABLE_TOAST_ID,
          description: status.availableVersion
            ? `Version ${status.availableVersion} is downloading in the background.`
            : 'An update is downloading in the background.'
        });
      }

      if (
        status.state === 'downloaded' &&
        !notifiedDownloadedVersionsRef.current.has(versionKey)
      ) {
        notifiedDownloadedVersionsRef.current.add(versionKey);
        toast('Desktop update ready', {
          id: READY_TOAST_ID,
          duration: Infinity,
          description: status.availableVersion
            ? `Version ${status.availableVersion} is ready to install.`
            : 'A new version is ready to install.',
          action: {
            label: 'Restart to Update',
            onClick: installUpdate
          }
        });
      }

      if (
        status.state === 'error' &&
        prevStateRef.current !== 'error' &&
        status.message
      ) {
        toast.error('Desktop update failed', {
          id: ERROR_TOAST_ID,
          description: status.message
        });
      }

      prevStateRef.current = status.state;
    };

    void desktopBridge.getUpdateStatus().then(handleStatus).catch(() => {
      // ignore initial status load errors
    });
    const unsubscribe = desktopBridge.subscribeUpdateStatus(handleStatus);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return null;
});

export { DesktopUpdateNotifier };
