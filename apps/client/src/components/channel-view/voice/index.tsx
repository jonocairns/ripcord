import { useVoiceUsersByChannelId } from '@/features/server/hooks';
import { memo } from 'react';
import { VoiceUser } from './voice-user';

type TChannelProps = {
  channelId: number;
};

const VoiceChannel = memo(({ channelId }: TChannelProps) => {
  const voiceUsers = useVoiceUsersByChannelId(channelId);

  return (
    <div className="flex flex-col gap-4 flex-1 items-center justify-center">
      <span className="text-xs text-muted-foreground">
        TODO: VOICE CHANNEL: {channelId}
      </span>

      <div>
        {voiceUsers.map((user) => (
          <VoiceUser key={user.id} userId={user.id} />
        ))}
      </div>
    </div>
  );
});

export { VoiceChannel };
