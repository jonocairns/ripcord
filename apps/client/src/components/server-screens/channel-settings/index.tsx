import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useChannelById } from '@/features/server/channels/hooks';
import { cn } from '@/lib/utils';
import { Lock, Search, Shield, SlidersHorizontal } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import type { TServerScreenBaseProps } from '../screens';
import { ServerScreenLayout } from '../server-screen-layout';
import { General } from './general';
import { ChannelPermissions } from './permissions';
import { Security } from './security';

type TChannelSettingsProps = TServerScreenBaseProps & {
  channelId: number;
};
type TChannelSettingsValue = 'general' | 'permissions' | 'security';
type TChannelSettingsSection = {
  keywords: string[];
  label: string;
  value: TChannelSettingsValue;
};

const CHANNEL_SETTINGS_SECTIONS: TChannelSettingsSection[] = [
  {
    value: 'general',
    label: 'General',
    keywords: ['general', 'name', 'topic', 'channel']
  },
  {
    value: 'permissions',
    label: 'Permissions',
    keywords: ['permissions', 'roles', 'members', 'access']
  },
  {
    value: 'security',
    label: 'Security',
    keywords: ['security', 'limits', 'slowmode', 'privacy']
  }
];

const ChannelSettings = memo(({ close, channelId }: TChannelSettingsProps) => {
  const channel = useChannelById(channelId);
  const [activeSection, setActiveSection] =
    useState<TChannelSettingsValue>('general');
  const [search, setSearch] = useState('');

  const filteredSections = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    if (!normalizedSearch) {
      return CHANNEL_SETTINGS_SECTIONS;
    }

    return CHANNEL_SETTINGS_SECTIONS.filter(({ label, keywords }) => {
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
      CHANNEL_SETTINGS_SECTIONS[0]
    );
  }, [activeSection, filteredSections]);

  return (
    <ServerScreenLayout close={close} title="Channel Settings">
      <div className="mx-auto flex w-full max-w-7xl gap-6">
        <aside className="w-full max-w-xs shrink-0 border-r border-border pr-4">
          <div className="space-y-4">
            <div className="px-2">
              <p className="truncate text-xl font-semibold">
                #{channel?.name ?? 'channel'}
              </p>
              <p className="text-sm text-muted-foreground">
                Manage channel settings
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
                Channel Settings
              </p>
              <nav className="space-y-1">
                {filteredSections.map((section) => {
                  const Icon =
                    section.value === 'general'
                      ? SlidersHorizontal
                      : section.value === 'permissions'
                        ? Shield
                        : Lock;

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
          {selectedSection.value === 'general' && (
            <General channelId={channelId} />
          )}
          {selectedSection.value === 'permissions' && (
            <ChannelPermissions channelId={channelId} />
          )}
          {selectedSection.value === 'security' && (
            <Security channelId={channelId} />
          )}
        </section>
      </div>
    </ServerScreenLayout>
  );
});

export { ChannelSettings };
