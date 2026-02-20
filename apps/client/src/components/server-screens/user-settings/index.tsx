import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UserAvatar } from '@/components/user-avatar';
import { useOwnPublicUser } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { KeyRound, Laptop2, Search, UserRound } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import type { TServerScreenBaseProps } from '../screens';
import { ServerScreenLayout } from '../server-screen-layout';
import { Devices } from './devices';
import { Password } from './password';
import { Profile } from './profile';

type TUserSettingsProps = TServerScreenBaseProps;
type TUserSettingsSection = {
  keywords: string[];
  label: string;
  value: 'devices' | 'password' | 'profile';
};

const USER_SETTINGS_SECTIONS: TUserSettingsSection[] = [
  {
    value: 'profile',
    label: 'My Account',
    keywords: ['account', 'profile', 'username', 'avatar']
  },
  {
    value: 'devices',
    label: 'Devices',
    keywords: ['devices', 'microphone', 'camera', 'audio', 'video']
  },
  {
    value: 'password',
    label: 'Password & Security',
    keywords: ['password', 'security', 'authentication']
  }
];

const UserSettings = memo(({ close }: TUserSettingsProps) => {
  const ownPublicUser = useOwnPublicUser();
  const [activeSection, setActiveSection] =
    useState<TUserSettingsSection['value']>('profile');
  const [search, setSearch] = useState('');

  const filteredSections = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    if (!normalizedSearch) {
      return USER_SETTINGS_SECTIONS;
    }

    return USER_SETTINGS_SECTIONS.filter(({ label, keywords }) => {
      return (
        label.toLowerCase().includes(normalizedSearch) ||
        keywords.some((keyword) => keyword.includes(normalizedSearch))
      );
    });
  }, [search]);

  const selectedSection = useMemo(() => {
    return (
      filteredSections.find(({ value }) => value === activeSection) ??
      filteredSections[0] ??
      USER_SETTINGS_SECTIONS[0]
    );
  }, [activeSection, filteredSections]);

  return (
    <ServerScreenLayout close={close} title="Settings">
      <div className="mx-auto flex w-full max-w-7xl gap-6">
        <aside className="w-full max-w-xs shrink-0 border-r border-border pr-4">
          <div className="space-y-4">
            <div className="flex items-center gap-3 px-2">
              {ownPublicUser && (
                <UserAvatar
                  userId={ownPublicUser.id}
                  showUserPopover={false}
                  className="h-12 w-12"
                />
              )}
              <div className="min-w-0">
                <p className="truncate text-xl font-semibold">
                  {ownPublicUser?.name ?? 'User'}
                </p>
                <p className="text-sm text-muted-foreground">Edit profile</p>
              </div>
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
                Settings
              </p>
              <nav className="space-y-1">
                {filteredSections.map((section) => {
                  const Icon =
                    section.value === 'profile'
                      ? UserRound
                      : section.value === 'devices'
                        ? Laptop2
                        : KeyRound;

                  return (
                    <Button
                      key={section.value}
                      variant="ghost"
                      onClick={() => setActiveSection(section.value)}
                      className={cn(
                        'w-full justify-start gap-3 px-3',
                        selectedSection.value === section.value
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
          {selectedSection.value === 'profile' && <Profile />}
          {selectedSection.value === 'devices' && <Devices />}
          {selectedSection.value === 'password' && <Password />}
        </section>
      </div>
    </ServerScreenLayout>
  );
});

export { UserSettings };
