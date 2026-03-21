import { useOwnVoiceUser } from '@/features/server/hooks';
import { useEffect, useRef, useState } from 'react';

// speaking intensity level (0 = silent, 1 = quiet, 2 = normal, 3 = loud)
// this might need to be optimized

enum SpeakingIntensity {
  Silent = 0,
  Quiet = 1,
  Normal = 2,
  Loud = 3
}

const ANALYZER_FFT_SIZE = 512;
const ANALYZER_MIN_DECIBELS = -90;
const ANALYZER_MAX_DECIBELS = -10;
const ANALYZER_SMOOTHING_TIME_CONSTANT = 0.85;
const SPEAKING_THRESHOLD = 8;

// Single shared AudioContext at 48kHz (matching WebRTC Opus) to avoid
// per-user resampling overhead and Chrome's AudioContext limit (~6).
let sharedAudioContext: AudioContext | null = null;
let sharedAudioContextUsers = 0;

const getSharedAudioContext = (): AudioContext | null => {
  if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
    sharedAudioContextUsers++;
    return sharedAudioContext;
  }

  const AudioContextClass =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioContextClass) return null;

  sharedAudioContext = new AudioContextClass({ sampleRate: 48_000 });
  sharedAudioContextUsers = 1;
  return sharedAudioContext;
};

const releaseSharedAudioContext = (context: AudioContext) => {
  // Only decrement if this caller's context is still the current shared one.
  // If the browser externally closed the context, a new one may have been
  // created — stale callers must not touch the new instance's ref count.
  if (context !== sharedAudioContext) return;

  sharedAudioContextUsers--;
  if (sharedAudioContextUsers <= 0) {
    sharedAudioContext.close().catch(() => {
      // Close can reject if the context is already closed — safe to ignore
      // since we're discarding the reference either way.
    });
    sharedAudioContext = null;
    sharedAudioContextUsers = 0;
  }
};

const useAudioLevel = (audioStream: MediaStream | undefined) => {
  const [audioLevel, setAudioLevel] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const acquiredContextRef = useRef<AudioContext | null>(null);
  const ownVoiceUser = useOwnVoiceUser();

  useEffect(() => {
    if (!audioStream || ownVoiceUser?.state.soundMuted) {
      setAudioLevel(0);
      setIsSpeaking(false);
      return;
    }

    const audioContext = getSharedAudioContext();

    if (!audioContext) return;

    acquiredContextRef.current = audioContext;
    let cancelled = false;

    const startAnalyser = () => {
      if (cancelled) return;

      try {
        const analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(audioStream);

        analyser.fftSize = ANALYZER_FFT_SIZE;
        analyser.minDecibels = ANALYZER_MIN_DECIBELS;
        analyser.maxDecibels = ANALYZER_MAX_DECIBELS;
        analyser.smoothingTimeConstant = ANALYZER_SMOOTHING_TIME_CONSTANT;

        source.connect(analyser);

        sourceRef.current = source;
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const checkAudioLevel = () => {
          if (!analyserRef.current) return;

          analyserRef.current.getByteFrequencyData(dataArray);

          // calculate rms (root mean square) of the frequency data
          let sum = 0;

          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i] * dataArray[i];
          }

          const rms = Math.sqrt(sum / dataArray.length);
          const normalizedLevel = Math.min(100, (rms / 255) * 100);

          setAudioLevel(normalizedLevel);
          setIsSpeaking(normalizedLevel > SPEAKING_THRESHOLD);

          animationFrameRef.current = requestAnimationFrame(checkAudioLevel);
        };

        checkAudioLevel();
      } catch (error) {
        console.warn('Audio level detection not supported:', error);
      }
    };

    if (audioContext.state === 'suspended') {
      audioContext.resume().then(startAnalyser, () => {
        console.warn('AudioContext resume failed — audio levels unavailable');
      });
    } else {
      startAnalyser();
    }

    return () => {
      cancelled = true;

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }

      if (sourceRef.current) {
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }

      if (analyserRef.current) {
        analyserRef.current.disconnect();
        analyserRef.current = null;
      }

      if (acquiredContextRef.current) {
        releaseSharedAudioContext(acquiredContextRef.current);
        acquiredContextRef.current = null;
      }

      setAudioLevel(0);
      setIsSpeaking(false);
    };
  }, [audioStream, ownVoiceUser?.state.soundMuted]);

  const speakingIntensity = isSpeaking
    ? audioLevel < 15
      ? SpeakingIntensity.Quiet
      : audioLevel < 30
        ? SpeakingIntensity.Normal
        : SpeakingIntensity.Loud
    : SpeakingIntensity.Silent;

  return {
    audioLevel,
    isSpeaking,
    speakingIntensity
  };
};

export { useAudioLevel };
