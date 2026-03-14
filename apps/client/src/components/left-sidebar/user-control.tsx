import { openServerScreen } from '@/features/server-screens/actions';
import { logoutFromServer } from '@/features/server/actions';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useOwnPublicUser } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { UserStatus } from '@sharkord/shared';
import { LogOut, Settings } from 'lucide-react';
import { memo, useCallback } from 'react';
import { ServerScreen } from '../server-screens/screens';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { UserAvatar } from '../user-avatar';
import { UserPopover } from '../user-popover';
import { UserStatusBadge } from '../user-status';
import { OwnVoiceControls } from './own-voice-controls';

const UserControl = memo(() => {
  const ownPublicUser = useOwnPublicUser();
  const currentVoiceChannelId = useCurrentVoiceChannelId();

  const handleSettingsClick = useCallback(() => {
    openServerScreen(ServerScreen.USER_SETTINGS);
  }, []);
  const handleLogoutClick = useCallback(() => {
    void logoutFromServer();
  }, []);

  if (!ownPublicUser) return null;

  const userStatus = ownPublicUser.status ?? UserStatus.OFFLINE;

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 px-3 py-3',
        currentVoiceChannelId !== undefined && 'border-t border-white/6'
      )}
    >
      <UserPopover
        userId={ownPublicUser.id}
        actions={
          <IconButton
            icon={LogOut}
            variant="destructive"
            size="default"
            className="h-9 w-9 rounded-md"
            title="Log out"
            onClick={handleLogoutClick}
          />
        }
      >
        <div className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-1 py-0.5">
          <UserAvatar
            userId={ownPublicUser.id}
            className="h-9 w-9 flex-shrink-0"
            showUserPopover={false}
            showStatusBadge={false}
          />
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-sm font-medium text-foreground truncate">
              {ownPublicUser.name}
            </span>
            <div className="flex items-center gap-1.5">
              <UserStatusBadge
                status={userStatus}
                className="h-2 w-2 border-0"
              />
              <span className="text-xs text-muted-foreground capitalize">
                {userStatus}
              </span>
            </div>
          </div>
        </div>
      </UserPopover>

      <div className="flex items-center gap-1">
        <OwnVoiceControls />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg text-muted-foreground transition-colors hover:bg-white/6 hover:text-white"
          onClick={handleSettingsClick}
          title="User Settings"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
});

export { UserControl };
