import { TypingDots } from '@/components/typing-dots';
import { setSelectedChannelId } from '@/features/server/channels/actions';
import {
  useChannelById,
  useChannelsByCategoryId,
  useSelectedChannelId
} from '@/features/server/channels/hooks';
import {
  useTypingUsersByChannelId,
  useVoiceUsersByChannelId
} from '@/features/server/hooks';
import { joinVoice } from '@/features/server/voice/actions';
import { useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import { ChannelType, type TChannel } from '@sharkord/shared';
import { Hash, Volume2 } from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';
import { ChannelContextMenu } from '../context-menus/channel';
import { VoiceUser } from './voice-user';

type TVoiceProps = Omit<TItemWrapperProps, 'children'> & {
  channel: TChannel;
};

const Voice = memo(({ channel, ...props }: TVoiceProps) => {
  const users = useVoiceUsersByChannelId(channel.id);

  return (
    <>
      <ItemWrapper {...props}>
        <Volume2 className="h-4 w-4" />
        <span className="flex-1">{channel.name}</span>
        {users.length > 0 && (
          <span className="text-xs text-muted-foreground ml-auto">
            {users.length}
          </span>
        )}
      </ItemWrapper>
      {channel.type === 'VOICE' && users.length > 0 && (
        <div className="ml-6 space-y-1 mt-1">
          {users.map((user) => (
            <VoiceUser key={user.id} userId={user.id} user={user} />
          ))}
        </div>
      )}
    </>
  );
});

type TTextProps = Omit<TItemWrapperProps, 'children'> & {
  channel: TChannel;
};

const Text = memo(({ channel, ...props }: TTextProps) => {
  const typingUsers = useTypingUsersByChannelId(channel.id);
  const hasTypingUsers = typingUsers.length > 0;

  return (
    <ItemWrapper {...props}>
      <Hash className="h-4 w-4" />
      <span className="flex-1">{channel.name}</span>
      {hasTypingUsers && (
        <div className="flex items-center gap-0.5 ml-auto">
          <TypingDots className="space-x-0.5" />
        </div>
      )}
    </ItemWrapper>
  );
});

type TItemWrapperProps = {
  children: React.ReactNode;
  className?: string;
  isSelected: boolean;
  onClick: () => void;
};

const ItemWrapper = memo(
  ({ children, isSelected, onClick, className }: TItemWrapperProps) => {
    return (
      <div
        className={cn(
          'flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground select-none',
          {
            'bg-accent text-accent-foreground': isSelected
          },
          className
        )}
        onClick={onClick}
      >
        {children}
      </div>
    );
  }
);

type TChannelProps = {
  channelId: number;
  isSelected: boolean;
};

const Channel = memo(({ channelId, isSelected }: TChannelProps) => {
  const channel = useChannelById(channelId);
  const { init } = useVoice();

  const onClick = useCallback(async () => {
    setSelectedChannelId(channelId);

    if (channel?.type === ChannelType.VOICE) {
      const response = await joinVoice(channelId);

      if (!response) {
        // joining voice failed
        setSelectedChannelId(undefined);
        toast.error('Failed to join voice channel');

        return;
      }

      try {
        await init(response, channelId);
      } catch {
        setSelectedChannelId(undefined);
        toast.error('Failed to initialize voice connection');
      }
    }
  }, [channelId, channel?.type, init]);

  if (!channel) {
    return null;
  }

  return (
    <ChannelContextMenu channelId={channelId}>
      <div>
        {channel.type === 'TEXT' && (
          <Text channel={channel} isSelected={isSelected} onClick={onClick} />
        )}
        {channel.type === 'VOICE' && (
          <Voice channel={channel} isSelected={isSelected} onClick={onClick} />
        )}
      </div>
    </ChannelContextMenu>
  );
});

type TChannelsProps = {
  categoryId: number;
};

const Channels = memo(({ categoryId }: TChannelsProps) => {
  const channels = useChannelsByCategoryId(categoryId);
  const selectedChannelId = useSelectedChannelId();

  return (
    <div className="space-y-0.5">
      {channels.map((channel) => (
        <Channel
          key={channel.id}
          channelId={channel.id}
          isSelected={selectedChannelId === channel.id}
        />
      ))}
    </div>
  );
});

export { Channels };
