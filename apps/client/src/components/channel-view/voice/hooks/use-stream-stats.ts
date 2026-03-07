import { useEffect, useRef, useState } from 'react';

export type StreamStats = {
  width: number;
  height: number;
  frameRate: number | null;
  bitrate: number | null;
};

const POLL_INTERVAL_MS = 2000;

const useStreamStats = (
  videoRef: React.RefObject<HTMLVideoElement | null>,
  videoStream: MediaStream | undefined
) => {
  const [stats, setStats] = useState<StreamStats | null>(null);
  const prevBytesRef = useRef<number | null>(null);
  const prevTimestampRef = useRef<number | null>(null);

  useEffect(() => {
    const poll = async () => {
      const video = videoRef.current;
      if (!video || !videoStream) {
        setStats(null);
        return;
      }

      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width === 0 || height === 0) return;

      const videoTrack = videoStream.getVideoTracks()[0];
      const settings = videoTrack?.getSettings();
      const frameRate = settings?.frameRate ?? null;

      let bitrate: number | null = null;

      // Try to get bitrate from RTCRtpReceiver stats if available
      // The video element's captureStream won't help, but we can check
      // if the track has an associated receiver via the PC internals
      // exposed by mediasoup — not directly available. Instead, we
      // estimate from the track's underlying receiver if we can find it.
      // Falls back to null if unavailable.
      if (videoTrack && 'getStats' in videoTrack) {
        try {
          // @ts-expect-error -- getStats exists on some tracks (non-standard but supported in Chromium)
          const report: RTCStatsReport = await videoTrack.getStats();
          for (const stat of report.values()) {
            if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
              const now = stat.timestamp;
              const bytes = stat.bytesReceived;
              if (
                prevBytesRef.current !== null &&
                prevTimestampRef.current !== null
              ) {
                const dt = (now - prevTimestampRef.current) / 1000;
                if (dt > 0) {
                  bitrate = ((bytes - prevBytesRef.current) * 8) / dt;
                }
              }
              prevBytesRef.current = bytes;
              prevTimestampRef.current = now;
              break;
            }
          }
        } catch {
          // getStats not available on this track
        }
      }

      setStats({ width, height, frameRate, bitrate });
    };

    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      clearInterval(id);
      prevBytesRef.current = null;
      prevTimestampRef.current = null;
    };
  }, [videoRef, videoStream]);

  return stats;
};

export { useStreamStats };
