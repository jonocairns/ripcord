import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { LoadingCard } from '@/components/ui/loading-card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { closeServerScreens } from '@/features/server-screens/actions';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useForm } from '@/hooks/use-form';
import {
  getRuntimeServerConfig,
  normalizeServerUrl,
  updateDesktopServerUrl
} from '@/runtime/server-config';
import { ScreenAudioMode } from '@/runtime/types';
import { Resolution } from '@/types';
import { Info } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useAvailableDevices } from './hooks/use-available-devices';
import ResolutionFpsControl from './resolution-fps-control';

const DEFAULT_NAME = 'default';

const Devices = memo(() => {
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const {
    inputDevices,
    videoDevices,
    loading: availableDevicesLoading
  } = useAvailableDevices();
  const { devices, saveDevices, loading: devicesLoading } = useDevices();
  const { values, onChange } = useForm(devices);
  const [desktopServerUrl, setDesktopServerUrl] = useState(
    getRuntimeServerConfig().serverUrl
  );
  const [savingServerUrl, setSavingServerUrl] = useState(false);

  const saveDeviceSettings = useCallback(() => {
    saveDevices(values);
    toast.success('Device settings saved');
  }, [saveDevices, values]);

  const saveDesktopServerUrl = useCallback(async () => {
    setSavingServerUrl(true);

    try {
      const normalized = normalizeServerUrl(desktopServerUrl);
      await updateDesktopServerUrl(normalized.url);
      toast.success('Desktop server URL saved');
      window.location.reload();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not save desktop URL';

      toast.error(message);
      setSavingServerUrl(false);
    }
  }, [desktopServerUrl]);

  if (availableDevicesLoading || devicesLoading) {
    return <LoadingCard className="h-[600px]" />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Devices</CardTitle>
        <CardDescription>
          Manage your peripheral devices and their settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {currentVoiceChannelId && (
          <Alert variant="default">
            <Info />
            <AlertDescription>
              You are in a voice channel, changes will only take effect after
              you leave and rejoin the channel.
            </AlertDescription>
          </Alert>
        )}
        <Group label="Microphone">
          <Select
            onValueChange={(value) => onChange('microphoneId', value)}
            value={values.microphoneId}
          >
            <SelectTrigger className="w-[500px]">
              <SelectValue placeholder="Select the input device" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {inputDevices.map((device) => (
                  <SelectItem
                    key={device?.deviceId}
                    value={device?.deviceId || DEFAULT_NAME}
                  >
                    {device?.label.trim() || 'Default Microphone'}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <div className="flex gap-8">
            <Group label="Echo cancellation">
              <Switch
                checked={!!values.echoCancellation}
                onCheckedChange={(checked) =>
                  onChange('echoCancellation', checked)
                }
              />
            </Group>

            <Group label="Noise suppression">
              <Switch
                checked={!!values.noiseSuppression}
                onCheckedChange={(checked) =>
                  onChange('noiseSuppression', checked)
                }
              />
            </Group>

            <Group label="Automatic gain control">
              <Switch
                checked={!!values.autoGainControl}
                onCheckedChange={(checked) =>
                  onChange('autoGainControl', checked)
                }
              />
            </Group>
          </div>
        </Group>

        <Group label="Webcam">
          <Select
            onValueChange={(value) => onChange('webcamId', value)}
            value={values.webcamId}
          >
            <SelectTrigger className="w-[500px]">
              <SelectValue placeholder="Select the input device" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {videoDevices.map((device) => (
                  <SelectItem
                    key={device?.deviceId}
                    value={device?.deviceId || DEFAULT_NAME}
                  >
                    {device?.label.trim() || 'Default Webcam'}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <ResolutionFpsControl
            framerate={values.webcamFramerate}
            resolution={values.webcamResolution}
            onFramerateChange={(value) => onChange('webcamFramerate', value)}
            onResolutionChange={(value) =>
              onChange('webcamResolution', value as Resolution)
            }
          />
          <Group label="Mirror own video">
            <Switch
              checked={!!values.mirrorOwnVideo}
              onCheckedChange={(checked) => onChange('mirrorOwnVideo', checked)}
            />
          </Group>
        </Group>

        <Group label="Screen Sharing">
          <Group label="Audio Mode">
            <Select
              onValueChange={(value) =>
                onChange('screenAudioMode', value as ScreenAudioMode)
              }
              value={values.screenAudioMode}
            >
              <SelectTrigger className="w-[250px]">
                <SelectValue placeholder="Select the audio mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ScreenAudioMode.SYSTEM}>
                    System audio
                  </SelectItem>
                  <SelectItem value={ScreenAudioMode.APP}>
                    Per-app audio
                  </SelectItem>
                  <SelectItem value={ScreenAudioMode.NONE}>
                    No shared audio
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Group>

          <ResolutionFpsControl
            framerate={values.screenFramerate}
            resolution={values.screenResolution}
            onFramerateChange={(value) => onChange('screenFramerate', value)}
            onResolutionChange={(value) =>
              onChange('screenResolution', value as Resolution)
            }
          />

          {window.sharkordDesktop && (
            <Group label="Use Rust sidecar capture (Experimental)">
              <Switch
                checked={!!values.experimentalRustCapture}
                onCheckedChange={(checked) =>
                  onChange('experimentalRustCapture', checked)
                }
              />
            </Group>
          )}
        </Group>
        {window.sharkordDesktop && (
          <Group label="Desktop Server URL">
            <div className="flex w-[500px] gap-2">
              <Input
                value={desktopServerUrl}
                onChange={(event) => setDesktopServerUrl(event.target.value)}
                onEnter={saveDesktopServerUrl}
                placeholder="http://localhost:4991"
              />
              <Button
                variant="outline"
                onClick={saveDesktopServerUrl}
                disabled={!desktopServerUrl.trim() || savingServerUrl}
              >
                Save URL
              </Button>
            </div>
          </Group>
        )}
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={closeServerScreens}>
            Cancel
          </Button>
          <Button onClick={saveDeviceSettings}>Save Changes</Button>
        </div>
      </CardContent>
    </Card>
  );
});

export { Devices };
