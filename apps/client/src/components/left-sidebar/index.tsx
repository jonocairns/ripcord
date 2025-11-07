import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { openServerScreen } from '@/features/server-screens/actions';
import { useServerName } from '@/features/server/hooks';
import { disconnect } from '@/lib/trpc';
import { Permission } from '@sharkord/shared';
import { Menu } from 'lucide-react';
import { memo } from 'react';
import { Protect } from '../protect';
import { ServerScreen } from '../server-screens/screens';
import { Button } from '../ui/button';
import { Categories } from './categories';
import { UserControl } from './user-control';

const LeftSidebar = memo(() => {
  const serverName = useServerName();

  return (
    <aside className="flex w-72 flex-col border-r border-border bg-card">
      <div className="flex w-full justify-between h-12 items-center border-b border-border px-4">
        <h2 className="font-semibold text-foreground">{serverName}</h2>
        <div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <Menu className="h-4 w-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Server</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <Protect permission={Permission.MANAGE_SERVER}>
                <DropdownMenuItem
                  onClick={() => openServerScreen(ServerScreen.SERVER_SETTINGS)}
                >
                  Settings
                </DropdownMenuItem>
              </Protect>
              <DropdownMenuItem onClick={disconnect}>
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <Categories />
      </div>
      <UserControl />
    </aside>
  );
});

export { UserControl } from './user-control';
export { LeftSidebar };
