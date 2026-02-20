import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCan, useServerName } from '@/features/server/hooks';
import { cn } from '@/lib/utils';
import { Permission } from '@sharkord/shared';
import {
  HardDrive,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Smile,
  Ticket,
  Users as UsersIcon
} from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import type { TServerScreenBaseProps } from '../screens';
import { ServerScreenLayout } from '../server-screen-layout';
import { Emojis } from './emojis';
import { General } from './general';
import { Invites } from './invites';
import { Plugins } from './plugins';
import { Roles } from './roles';
import { Storage } from './storage';
import { Updates } from './updates';
import { Users } from './users';

type TServerSettingsProps = TServerScreenBaseProps;
type TServerSettingsValue =
  | 'emojis'
  | 'general'
  | 'invites'
  | 'plugins'
  | 'roles'
  | 'storage'
  | 'updates'
  | 'users';
type TServerSettingsSection = {
  keywords: string[];
  label: string;
  permission: Permission;
  value: TServerSettingsValue;
};

const SERVER_SETTINGS_SECTIONS: TServerSettingsSection[] = [
  {
    value: 'general',
    label: 'General',
    permission: Permission.MANAGE_SETTINGS,
    keywords: ['general', 'server', 'name', 'description']
  },
  {
    value: 'roles',
    label: 'Roles',
    permission: Permission.MANAGE_ROLES,
    keywords: ['roles', 'permissions', 'access']
  },
  {
    value: 'emojis',
    label: 'Emojis',
    permission: Permission.MANAGE_EMOJIS,
    keywords: ['emoji', 'stickers', 'assets']
  },
  {
    value: 'storage',
    label: 'Storage',
    permission: Permission.MANAGE_STORAGE,
    keywords: ['storage', 'quota', 'files']
  },
  {
    value: 'users',
    label: 'Users',
    permission: Permission.MANAGE_USERS,
    keywords: ['users', 'members', 'moderation']
  },
  {
    value: 'invites',
    label: 'Invites',
    permission: Permission.MANAGE_INVITES,
    keywords: ['invites', 'links', 'join']
  },
  {
    value: 'updates',
    label: 'Updates',
    permission: Permission.MANAGE_UPDATES,
    keywords: ['updates', 'version', 'maintenance']
  },
  {
    value: 'plugins',
    label: 'Plugins',
    permission: Permission.MANAGE_PLUGINS,
    keywords: ['plugins', 'extensions', 'integrations']
  }
];

const ServerSettings = memo(({ close }: TServerSettingsProps) => {
  const can = useCan();
  const serverName = useServerName();
  const [search, setSearch] = useState('');

  const defaultSection = useMemo<TServerSettingsValue>(() => {
    if (can(Permission.MANAGE_SETTINGS)) return 'general';
    if (can(Permission.MANAGE_ROLES)) return 'roles';
    if (can(Permission.MANAGE_EMOJIS)) return 'emojis';
    if (can(Permission.MANAGE_STORAGE)) return 'storage';
    if (can(Permission.MANAGE_USERS)) return 'users';
    if (can(Permission.MANAGE_INVITES)) return 'invites';
    if (can(Permission.MANAGE_UPDATES)) return 'updates';
    if (can(Permission.MANAGE_PLUGINS)) return 'plugins';
    return 'general';
  }, [can]);
  const [activeSection, setActiveSection] =
    useState<TServerSettingsValue>(defaultSection);

  const filteredSections = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    if (!normalizedSearch) {
      return SERVER_SETTINGS_SECTIONS;
    }

    return SERVER_SETTINGS_SECTIONS.filter(({ label, keywords }) => {
      return (
        label.toLowerCase().includes(normalizedSearch) ||
        keywords.some((keyword) => keyword.includes(normalizedSearch))
      );
    });
  }, [search]);

  const selectedSection = useMemo(() => {
    const allowedSections = SERVER_SETTINGS_SECTIONS.filter((section) =>
      can(section.permission)
    );
    const allowedFilteredSections = filteredSections.filter((section) =>
      can(section.permission)
    );

    return (
      allowedFilteredSections.find(({ value }) => value === activeSection) ??
      allowedFilteredSections[0] ??
      allowedSections[0]
    );
  }, [activeSection, can, filteredSections]);

  return (
    <ServerScreenLayout close={close} title="Server Settings">
      <div className="mx-auto flex w-full max-w-7xl gap-6">
        <aside className="w-full max-w-xs shrink-0 border-r border-border pr-4">
          <div className="space-y-4">
            <div className="px-2">
              <p className="truncate text-xl font-semibold">
                {serverName ?? 'Server'}
              </p>
              <p className="text-sm text-muted-foreground">
                Manage server settings
              </p>
            </div>

            <div className="relative px-2">
              <Search className="pointer-events-none absolute top-1/2 left-5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search"
                className="pl-9"
              />
            </div>

            <div className="max-h-[calc(100vh-15rem)] overflow-y-auto px-2 pb-2">
              <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Server Settings
              </p>
              <nav className="space-y-1">
                {filteredSections.map((section) => {
                  const Icon =
                    section.value === 'general'
                      ? Settings
                      : section.value === 'roles'
                        ? Shield
                        : section.value === 'emojis'
                          ? Smile
                          : section.value === 'storage'
                            ? HardDrive
                            : section.value === 'users'
                              ? UsersIcon
                              : section.value === 'invites'
                                ? Ticket
                                : section.value === 'updates'
                                  ? RefreshCw
                                  : Puzzle;
                  const isAllowed = can(section.permission);
                  const isSelected = selectedSection?.value === section.value;

                  return (
                    <Button
                      key={section.value}
                      variant="ghost"
                      onClick={() => {
                        if (!isAllowed) return;
                        setActiveSection(section.value);
                      }}
                      disabled={!isAllowed}
                      className={cn(
                        'w-full justify-start gap-3 px-3',
                        isSelected
                          ? 'bg-muted text-foreground hover:bg-muted'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {section.label}
                    </Button>
                  );
                })}
              </nav>

              {filteredSections.length === 0 && (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  No settings found.
                </p>
              )}
            </div>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          {selectedSection?.value === 'general' &&
            can(Permission.MANAGE_SETTINGS) && <General />}
          {selectedSection?.value === 'roles' &&
            can(Permission.MANAGE_ROLES) && <Roles />}
          {selectedSection?.value === 'emojis' &&
            can(Permission.MANAGE_EMOJIS) && <Emojis />}
          {selectedSection?.value === 'storage' &&
            can(Permission.MANAGE_STORAGE) && <Storage />}
          {selectedSection?.value === 'users' &&
            can(Permission.MANAGE_USERS) && <Users />}
          {selectedSection?.value === 'invites' &&
            can(Permission.MANAGE_INVITES) && <Invites />}
          {selectedSection?.value === 'updates' &&
            can(Permission.MANAGE_UPDATES) && <Updates />}
          {selectedSection?.value === 'plugins' &&
            can(Permission.MANAGE_PLUGINS) && <Plugins />}

          {!selectedSection && (
            <div className="rounded-md border border-border bg-card p-6">
              <p className="text-sm text-muted-foreground">
                You do not have permission to view server settings.
              </p>
            </div>
          )}
        </section>
      </div>
    </ServerScreenLayout>
  );
});

export { ServerSettings };
