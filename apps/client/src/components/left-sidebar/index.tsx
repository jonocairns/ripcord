import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { openDialog } from '@/features/dialogs/actions';
import { openServerScreen } from '@/features/server-screens/actions';
import { useCategories } from '@/features/server/categories/hooks';
import { useInfo, useServerName } from '@/features/server/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { getInitialsFromName } from '@/helpers/get-initials-from-name';
import { cn } from '@/lib/utils';
import { Permission } from '@sharkord/shared';
import { ChevronDown, FolderPlus, Hash, Settings } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { Dialog } from '../dialogs/dialogs';
import { Protect } from '../protect';
import { ServerScreen } from '../server-screens/screens';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { Button } from '../ui/button';
import { Categories } from './categories';
import { UserControl } from './user-control';
import { VoiceControl } from './voice-control';

type TLeftSidebarProps = {
  className?: string;
};

const LeftSidebar = memo(({ className }: TLeftSidebarProps) => {
  const serverName = useServerName();
  const serverInfo = useInfo();
  const [menuOpen, setMenuOpen] = useState(false);
  const categories = useCategories();
  const safeServerName = serverName ?? 'Server';
  const firstCategoryId = categories[0]?.id;
  const serverSettingsPermissions = useMemo(
    () => [
      Permission.MANAGE_SETTINGS,
      Permission.MANAGE_ROLES,
      Permission.MANAGE_EMOJIS,
      Permission.MANAGE_STORAGE,
      Permission.MANAGE_USERS,
      Permission.MANAGE_INVITES,
      Permission.MANAGE_UPDATES,
      Permission.MANAGE_PLUGINS
    ],
    []
  );

  return (
    <aside
      className={cn(
        'flex w-72 flex-col border-r border-border bg-card h-full',
        className
      )}
    >
      <div className="flex w-full h-12 items-center border-b border-border px-2">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="h-10 w-full justify-between px-2 text-left"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Avatar className="h-6 w-6 rounded-md">
                  <AvatarImage
                    src={getFileUrl(serverInfo?.logo)}
                    key={serverInfo?.logo?.id}
                  />
                  <AvatarFallback className="rounded-md bg-muted/80 text-[10px] font-semibold text-foreground">
                    {getInitialsFromName(safeServerName)}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate font-semibold text-foreground">
                  {safeServerName}
                </span>
              </span>
              <ChevronDown
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform',
                  menuOpen && 'rotate-180'
                )}
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64">
            <DropdownMenuLabel>Server</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <Protect permission={serverSettingsPermissions}>
              <DropdownMenuItem
                onClick={() => openServerScreen(ServerScreen.SERVER_SETTINGS)}
              >
                <Settings className="h-4 w-4" />
                Server Settings
              </DropdownMenuItem>
            </Protect>
            <Protect permission={Permission.MANAGE_CHANNELS}>
              <DropdownMenuItem
                disabled={!firstCategoryId}
                onClick={() => {
                  if (!firstCategoryId) return;

                  openDialog(Dialog.CREATE_CHANNEL, {
                    categoryId: firstCategoryId
                  });
                }}
              >
                <Hash className="h-4 w-4" />
                Create Channel
              </DropdownMenuItem>
            </Protect>
            <Protect permission={Permission.MANAGE_CATEGORIES}>
              <DropdownMenuItem
                onClick={() => openDialog(Dialog.CREATE_CATEGORY)}
              >
                <FolderPlus className="h-4 w-4" />
                Create Category
              </DropdownMenuItem>
            </Protect>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex-1 overflow-y-auto">
        <Categories />
      </div>
      <VoiceControl />
      <UserControl />
    </aside>
  );
});

export { UserControl } from './user-control';
export { LeftSidebar };
