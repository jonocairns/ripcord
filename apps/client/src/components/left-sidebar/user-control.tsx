import { openServerScreen } from '@/features/server-screens/actions';
import { logoutFromServer } from '@/features/server/actions';
import { useOwnPublicUser } from '@/features/server/users/hooks';
import { LogOut, Settings } from 'lucide-react';
import { memo, useCallback } from 'react';
import { ServerScreen } from '../server-screens/screens';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { UserAvatar } from '../user-avatar';
import { UserPopover } from '../user-popover';

const UserControl = memo(() => {
  const ownPublicUser = useOwnPublicUser();

  const handleSettingsClick = useCallback(() => {
    openServerScreen(ServerScreen.USER_SETTINGS);
  }, []);
  const handleLogoutClick = useCallback(() => {
    void logoutFromServer();
  }, []);

  if (!ownPublicUser) return null;

  return (
    <div className="flex h-14 items-center justify-between border-t border-border bg-muted/20 px-2">
      <UserPopover
        userId={ownPublicUser.id}
        actions={
          <IconButton
            icon={LogOut}
            variant="destructive"
            size="sm"
            title="Log out"
            onClick={handleLogoutClick}
          />
        }
      >
        <div className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md p-1 transition-colors hover:bg-muted/30">
          <UserAvatar
            userId={ownPublicUser.id}
            className="h-8 w-8 flex-shrink-0"
            showUserPopover={false}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium text-foreground truncate">
              {ownPublicUser.name}
            </span>
            <div className="flex items-center space-x-1">
              <span className="text-xs text-muted-foreground capitalize">
                {ownPublicUser.status}
              </span>
            </div>
          </div>
        </div>
      </UserPopover>

      <div className="ml-2 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
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
