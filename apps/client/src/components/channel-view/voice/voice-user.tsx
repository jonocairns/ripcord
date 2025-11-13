import { useUserById } from '@/features/server/users/hooks';
import { memo } from 'react';
import { useVoiceRefs } from './hooks/use-voice-refs';

type TVoiceUserProps = {
  userId: number;
};

const VoiceUser = memo(({ userId }: TVoiceUserProps) => {
  const user = useUserById(userId);
  const {
    videoRef,
    audioRef,
    hasAudioStream,
    hasVideoStream,
    screenShareRef,
    hasScreenShareStream
  } = useVoiceRefs(userId);

  return (
    <div className="flex p-2 aspect-video bg-primary/15 rounded-lg overflow-hidden relative items-center justify-center select-none">
      {hasVideoStream && (
        <video
          ref={videoRef}
          autoPlay
          muted
          loop
          className="absolute top-0 left-0 w-full h-full object-cover"
        />
      )}
      {hasScreenShareStream && (
        <video
          ref={screenShareRef}
          autoPlay
          muted
          loop
          className="absolute top-0 left-0 w-full h-full object-cover"
        />
      )}
      {hasAudioStream && <audio ref={audioRef} className="hidden" autoPlay />}

      {user?.name}
    </div>
  );
});

export { VoiceUser };
