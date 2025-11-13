import { LeftSidebar } from '@/components/left-sidebar';
import { ModViewSheet } from '@/components/mod-view-sheet';
import { Protect } from '@/components/protect';
import { RightSidebar } from '@/components/right-sidebar';
import { VoiceProvider } from '@/components/voice-provider';
import { Permission } from '@sharkord/shared';
import { memo } from 'react';
import { ContentWrapper } from './content-wrapper';

const ServerView = memo(() => {
  return (
    <VoiceProvider>
      <div className="flex h-screen flex-col bg-background text-foreground dark">
        <div className="flex flex-1 overflow-hidden">
          <LeftSidebar />
          <ContentWrapper />
          <RightSidebar />
          <Protect permission={Permission.MANAGE_USERS}>
            <ModViewSheet />
          </Protect>
        </div>
      </div>
    </VoiceProvider>
  );
});

export { ServerView };
