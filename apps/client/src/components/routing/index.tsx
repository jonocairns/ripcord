import { memo, useEffect } from 'react';
import { useIsAppLoading } from '@/features/app/hooks';
import { useDisconnectInfo, useHasServerSession, useMustChangePassword, useServerName } from '@/features/server/hooks';
import { isDesktopServerSetupRequired } from '@/runtime/server-config';
import { Connect } from '@/screens/connect';
import { DesktopServerSetup } from '@/screens/desktop-server-setup';
import { Disconnected } from '@/screens/disconnected';
import { ForcePasswordReset } from '@/screens/force-password-reset';
import { LoadingApp } from '@/screens/loading-app';
import { ServerView } from '@/screens/server-view';

const Routing = memo(() => {
	const hasServerSession = useHasServerSession();
	const isAppLoading = useIsAppLoading();
	const disconnectInfo = useDisconnectInfo();
	const mustChangePassword = useMustChangePassword();
	const serverName = useServerName();

	useEffect(() => {
		if (hasServerSession && serverName) {
			document.title = `${serverName} - Ripcord`;
			return;
		}

		document.title = 'Ripcord';
	}, [hasServerSession, serverName]);

	if (isDesktopServerSetupRequired()) {
		return <DesktopServerSetup />;
	}

	if (isAppLoading) {
		return <LoadingApp />;
	}

	if (!hasServerSession) {
		if (disconnectInfo) {
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
