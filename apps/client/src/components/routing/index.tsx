import { useIsAppLoading } from '@/features/app/hooks';
import {
  useDisconnectInfo,
  useIsConnected,
  useMustChangePassword,
  useServerName
} from '@/features/server/hooks';
import { isDesktopServerSetupRequired } from '@/runtime/server-config';
import { Connect } from '@/screens/connect';
import { DesktopServerSetup } from '@/screens/desktop-server-setup';
import { Disconnected } from '@/screens/disconnected';
import { ForcePasswordReset } from '@/screens/force-password-reset';
import { LoadingApp } from '@/screens/loading-app';
import { ServerView } from '@/screens/server-view';
import { DisconnectCode } from '@sharkord/shared';
import { memo, useEffect } from 'react';

const Routing = memo(() => {
  const isConnected = useIsConnected();
  const isAppLoading = useIsAppLoading();
  const disconnectInfo = useDisconnectInfo();
  const mustChangePassword = useMustChangePassword();
  const serverName = useServerName();

  useEffect(() => {
    if (isConnected && serverName) {
      document.title = `${serverName} - Ripcord`;
      return;
    }

    document.title = 'Ripcord';
  }, [isConnected, serverName]);

  if (isDesktopServerSetupRequired()) {
    return <DesktopServerSetup />;
  }

  if (isAppLoading) {
    return <LoadingApp />;
  }

  if (!isConnected) {
    if (
      disconnectInfo &&
      (!disconnectInfo.wasClean ||
        disconnectInfo.code === DisconnectCode.KICKED ||
        disconnectInfo.code === DisconnectCode.BANNED)
    ) {
      return <Disconnected info={disconnectInfo} />;
    }

    return <Connect />;
  }

  if (mustChangePassword) {
    return <ForcePasswordReset />;
  }

  return <ServerView />;
});

export { Routing };
