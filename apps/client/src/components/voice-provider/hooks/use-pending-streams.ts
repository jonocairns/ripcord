import { StreamKind } from '@sharkord/shared';
import { useCallback, useState } from 'react';

export type TPendingStream = {
  remoteId: number;
  kind: StreamKind;
};

export const getPendingStreamKey = (remoteId: number, kind: StreamKind) =>
  `${remoteId}-${kind}`;

const isUserPendingStreamKind = (kind: StreamKind) => {
  return (
    kind === StreamKind.AUDIO ||
    kind === StreamKind.VIDEO ||
    kind === StreamKind.SCREEN ||
    kind === StreamKind.SCREEN_AUDIO
  );
};

const usePendingStreams = () => {
  const [pendingStreams, setPendingStreams] = useState<Map<string, TPendingStream>>(
    () => new Map()
  );

  const addPendingStream = useCallback((remoteId: number, kind: StreamKind) => {
    setPendingStreams((prev) => {
      const key = getPendingStreamKey(remoteId, kind);

      if (prev.has(key)) {
        return prev;
      }

      const next = new Map(prev);
      next.set(key, { remoteId, kind });

      return next;
    });
  }, []);

  const removePendingStream = useCallback(
    (remoteId: number, kind: StreamKind) => {
      setPendingStreams((prev) => {
        const key = getPendingStreamKey(remoteId, kind);

        if (!prev.has(key)) {
          return prev;
        }

        const next = new Map(prev);
        next.delete(key);

        return next;
      });
    },
    []
  );

  const clearPendingStreamsForUser = useCallback((remoteId: number) => {
    setPendingStreams((prev) => {
      let changed = false;
      const next = new Map(prev);

      next.forEach((stream, key) => {
        if (
          stream.remoteId !== remoteId ||
          !isUserPendingStreamKind(stream.kind)
        ) {
          return;
        }

        next.delete(key);
        changed = true;
      });

      return changed ? next : prev;
    });
  }, []);

  const clearAllPendingStreams = useCallback(() => {
    setPendingStreams((prev) => {
      if (prev.size === 0) {
        return prev;
      }

      return new Map();
    });
  }, []);

  return {
    pendingStreams,
    addPendingStream,
    removePendingStream,
    clearPendingStreamsForUser,
    clearAllPendingStreams
  };
};

export { usePendingStreams };
