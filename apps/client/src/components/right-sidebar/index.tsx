import { UserAvatar } from '@/components/user-avatar';
import { useUsers } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { PanelRight, PanelRightClose } from 'lucide-react';
import { memo, useMemo } from 'react';
import { Button } from '../ui/button';
import { Tooltip } from '../ui/tooltip';
import { UserPopover } from '../user-popover';

const MAX_USERS_TO_SHOW = 100;

type TUserProps = {
  userId: number;
  name: string;
  banned: boolean;
  isCollapsed?: boolean;
};

const User = memo(
  ({ userId, name, banned, isCollapsed = false }: TUserProps) => {
    return (
      <UserPopover userId={userId}>
        <div
          className={cn(
            'flex items-center gap-3 rounded px-2 py-1.5 hover:bg-accent select-none',
            isCollapsed && 'lg:justify-center lg:px-1 lg:py-1'
          )}
          title={name}
        >
          <UserAvatar userId={userId} className="h-8 w-8" />
          <div
            className={cn(
              'min-w-0 overflow-hidden lg:max-w-[9.5rem] lg:opacity-100 lg:transition-[max-width,opacity] lg:duration-200 lg:ease-out',
              isCollapsed && 'lg:max-w-0 lg:opacity-0'
            )}
          >
            <span
              className={cn(
                'block truncate text-sm text-foreground',
                banned && 'line-through text-muted-foreground'
              )}
            >
              {name}
            </span>
          </div>
        </div>
      </UserPopover>
    );
  }
);

type TRightSidebarProps = {
  className?: string;
  isOpen?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
};

const RightSidebar = memo(
  ({
    className,
    isOpen = true,
    isCollapsed = false,
    onToggleCollapse
  }: TRightSidebarProps) => {
    const users = useUsers();

    const usersToShow = useMemo(
      () => users.slice(0, MAX_USERS_TO_SHOW),
      [users]
    );

    const hasHiddenUsers = users.length > MAX_USERS_TO_SHOW;

    return (
      <aside
        className={cn(
          'flex flex-col border-l border-border bg-card h-full transition-all duration-500 ease-in-out',
          isOpen && isCollapsed
            ? 'w-60 lg:w-16'
            : isOpen
              ? 'w-60'
              : 'w-0 border-l-0',
          className
        )}
        style={{ overflow: 'hidden' }}
      >
        {isOpen && (
          <>
            <div
              className={cn(
                'flex h-12 items-center border-b border-border px-3 justify-between',
                isCollapsed && 'lg:px-2 lg:justify-center'
              )}
            >
              <div
                className={cn(
                  'overflow-hidden whitespace-nowrap text-sm font-semibold text-foreground lg:max-w-28 lg:opacity-100 lg:transition-[max-width,opacity] lg:duration-200 lg:ease-out',
                  isCollapsed && 'lg:max-w-0 lg:opacity-0'
                )}
              >
                Members
              </div>
              {onToggleCollapse && (
                <Tooltip
                  content={isCollapsed ? 'Expand Members' : 'Collapse Members'}
                >
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="hidden lg:inline-flex"
                    onClick={onToggleCollapse}
                  >
                    {isCollapsed ? (
                      <PanelRight className="h-4 w-4" />
                    ) : (
                      <PanelRightClose className="h-4 w-4" />
                    )}
                  </Button>
                </Tooltip>
              )}
            </div>
            <div
              className={cn(
                'flex-1 overflow-y-auto p-2',
                isCollapsed && 'lg:p-1'
              )}
            >
              <div
                className={cn(
                  'space-y-1',
                  isCollapsed &&
                    'lg:flex lg:flex-col lg:items-center lg:space-y-2'
                )}
              >
                {usersToShow.map((user) => (
                  <User
                    key={user.id}
                    userId={user.id}
                    name={user.name}
                    banned={user.banned}
                    isCollapsed={isCollapsed}
                  />
                ))}
                {hasHiddenUsers && (
                  <div
                    className={cn(
                      'text-sm text-muted-foreground px-2 py-1.5',
                      isCollapsed && 'lg:hidden'
                    )}
                  >
                    More members...
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </aside>
    );
  }
);

export { RightSidebar };
