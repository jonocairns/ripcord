import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import {
  normalizeServerUrl,
  updateDesktopServerUrl
} from '@/runtime/server-config';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';

const DesktopServerSetup = memo(() => {
  const [serverUrl, setServerUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const onSave = useCallback(async () => {
    setSaving(true);

    try {
      const normalized = normalizeServerUrl(serverUrl);
      await updateDesktopServerUrl(normalized.url);
      window.location.reload();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save server URL';

      toast.error(message);
      setSaving(false);
    }
  }, [serverUrl]);

  return (
    <div className="flex items-center justify-center h-full p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Desktop Setup</CardTitle>
          <CardDescription>
            Enter Ripcord URL this desktop client should connect to.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Group label="Server URL">
            <Input
              placeholder="http://localhost:4991"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              onEnter={onSave}
              disabled={saving}
            />
          </Group>

          <Button
            className="w-full"
            onClick={onSave}
            disabled={!serverUrl.trim() || saving}
          >
            Save and Continue
          </Button>
        </CardContent>
      </Card>
    </div>
  );
});

export { DesktopServerSetup };
