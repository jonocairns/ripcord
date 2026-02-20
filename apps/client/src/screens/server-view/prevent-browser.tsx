import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { usePreventExit } from '@/hooks/use-prevent-exit';
import { isDesktopRuntime } from '@/runtime/desktop-bridge';
import { memo } from 'react';

const PreventBrowser = memo(() => {
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const shouldPreventExit = !isDesktopRuntime() && !!currentVoiceChannelId;

  // Keep browser-tab protection, but allow Electron window close to quit directly.
  usePreventExit(shouldPreventExit);

  return null;
});

export { PreventBrowser };
