import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { memo } from 'react';
import type { TServerScreenBaseProps } from '../screens';
import { ServerScreenLayout } from '../server-screen-layout';
import { Emojis } from './emojis';
import { General } from './general';
import { Roles } from './roles';
import { Storage } from './storage';

type TServerSettingsProps = TServerScreenBaseProps;

const ServerSettings = memo(({ close }: TServerSettingsProps) => {
  return (
    <ServerScreenLayout close={close} title="Server Settings">
      <div className="mx-auto max-w-4xl">
        <Tabs defaultValue="general" className="w-full">
          <TabsList className="mb-6">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            <TabsTrigger value="emojis">Emojis</TabsTrigger>
            <TabsTrigger value="storage">Storage</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="space-y-6">
            <General />
          </TabsContent>
          <TabsContent value="roles" className="space-y-6">
            <Roles />
          </TabsContent>
          <TabsContent value="emojis" className="space-y-6">
            <Emojis />
          </TabsContent>
          <TabsContent value="storage" className="space-y-6">
            <Storage />
          </TabsContent>
        </Tabs>
      </div>
    </ServerScreenLayout>
  );
});

export { ServerSettings };
