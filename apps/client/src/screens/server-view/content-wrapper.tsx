import { TextChannel } from '@/components/channel-view/text';
import { VoiceChannel } from '@/components/channel-view/voice';
import {
  useSelectedChannelId,
  useSelectedChannelType
} from '@/features/server/channels/hooks';
import { ChannelType } from '@sharkord/shared';
import { memo } from 'react';

const ContentWrapper = memo(() => {
  const selectedChannelId = useSelectedChannelId();
  const selectedChannelType = useSelectedChannelType();

  let content;

  if (selectedChannelId) {
    if (selectedChannelType === ChannelType.TEXT) {
      content = (
        <TextChannel key={selectedChannelId} channelId={selectedChannelId} />
      );
    } else if (selectedChannelType === ChannelType.VOICE) {
      content = (
        <VoiceChannel key={selectedChannelId} channelId={selectedChannelId} />
      );
    }
  } else {
    content = null;
  }

  return <main className="flex flex-1 flex-col bg-background relative">{content}</main>;
});

export { ContentWrapper };
