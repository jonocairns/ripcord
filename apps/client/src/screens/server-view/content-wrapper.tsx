import { TextChannel } from '@/components/channel-view/text';
import { VoiceChannel } from '@/components/channel-view/voice';
import { useSelectedChannel } from '@/features/server/channels/hooks';
import { ChannelType } from '@sharkord/shared';
import { memo } from 'react';

const ContentWrapper = memo(() => {
  const selectedChannel = useSelectedChannel();

  let content;

  if (selectedChannel) {
    if (selectedChannel.type === ChannelType.TEXT) {
      content = (
        <TextChannel key={selectedChannel.id} channelId={selectedChannel.id} />
      );
    } else if (selectedChannel.type === ChannelType.VOICE) {
      content = (
        <VoiceChannel key={selectedChannel.id} channelId={selectedChannel.id} />
      );
    }
  } else {
    content = null;
  }

  return <main className="flex flex-1 flex-col bg-background">{content}</main>;
});

export { ContentWrapper };
