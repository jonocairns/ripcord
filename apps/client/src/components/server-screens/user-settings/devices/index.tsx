import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import {
  formatPushKeybindLabel,
  pushKeybindFromKeyState
} from '@/components/devices-provider/push-keybind';
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
import { Resolution, VideoCodecPreference, VoiceFilterStrength } from '@/types';
import { Info } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAvailableDevices } from './hooks/use-available-devices';
import ResolutionFpsControl from './resolution-fps-control';

const DEFAULT_NAME = 'default';
type TPushKeybindField = 'pushToTalkKeybind' | 'pushToMuteKeybind';

const Devices = memo(() => {
  const hasDesktopBridge =
    typeof window !== 'undefined' && Boolean(window.sharkordDesktop);
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
  const [capturingKeybindField, setCapturingKeybindField] = useState<
    TPushKeybindField | undefined
  >(undefined);

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

  const clearPushKeybind = useCallback(
    (field: TPushKeybindField) => {
      onChange(field, undefined);

      if (capturingKeybindField === field) {
        setCapturingKeybindField(undefined);
      }
    },
    [capturingKeybindField, onChange]
  );

  const startPushKeybindCapture = useCallback(
    (field: TPushKeybindField) => {
      if (!hasDesktopBridge) {
        return;
      }

      setCapturingKeybindField(field);
    },
    [hasDesktopBridge]
  );

  useEffect(() => {
    if (!capturingKeybindField || !hasDesktopBridge) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === 'Escape') {
        setCapturingKeybindField(undefined);
        return;
      }

      const nextKeybind = pushKeybindFromKeyState({
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey
      });

      if (!nextKeybind) {
        return;
      }

      const conflictingKeybind =
        capturingKeybindField === 'pushToTalkKeybind'
          ? values.pushToMuteKeybind
          : values.pushToTalkKeybind;

      if (conflictingKeybind && conflictingKeybind === nextKeybind) {
        toast.error('Push-to-talk and push-to-mute cannot use the same keybind');
        return;
      }

      onChange(capturingKeybindField, nextKeybind);
      setCapturingKeybindField(undefined);
    };

    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [
    capturingKeybindField,
    hasDesktopBridge,
    onChange,
    values.pushToMuteKeybind,
    values.pushToTalkKeybind
  ]);

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

            <Group label="DeepFilterNet filter (Desktop)">
              <Switch
                checked={!!values.experimentalVoiceFilter}
                onCheckedChange={(checked) =>
                  onChange('experimentalVoiceFilter', checked)
                }
                disabled={!hasDesktopBridge}
              />
            </Group>
          </div>
          <p className="text-xs text-muted-foreground">
            Uses desktop sidecar processing for noise suppression and automatic
            gain control. Echo cancellation remains browser-based for now.
            Higher strength reduces more background noise but may affect voice
            quality. This filter is available in the desktop app.
          </p>
          <Group label="Voice filter strength">
            <Select
              onValueChange={(value) =>
                onChange('voiceFilterStrength', value as VoiceFilterStrength)
              }
              value={values.voiceFilterStrength}
              disabled={!hasDesktopBridge || !values.experimentalVoiceFilter}
            >
              <SelectTrigger className="w-[240px]">
                <SelectValue placeholder="Select a filter preset" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={VoiceFilterStrength.LOW}>Low</SelectItem>
                  <SelectItem value={VoiceFilterStrength.BALANCED}>
                    Balanced
                  </SelectItem>
                  <SelectItem value={VoiceFilterStrength.HIGH}>High</SelectItem>
                  <SelectItem value={VoiceFilterStrength.AGGRESSIVE}>
                    Aggressive
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Group>
          {hasDesktopBridge && (
            <Group label="Push keybinds (Desktop)">
              <div className="w-[500px] space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-28 text-sm">Push to talk</span>
                  <Button
                    variant="outline"
                    type="button"
                    className="min-w-[220px] justify-start font-mono"
                    data-push-keybind-capture={
                      capturingKeybindField === 'pushToTalkKeybind'
                        ? 'true'
                        : undefined
                    }
                    onClick={() => startPushKeybindCapture('pushToTalkKeybind')}
                  >
                    {capturingKeybindField === 'pushToTalkKeybind'
                      ? 'Press keys...'
                      : formatPushKeybindLabel(values.pushToTalkKeybind)}
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => clearPushKeybind('pushToTalkKeybind')}
                    disabled={!values.pushToTalkKeybind}
                  >
                    Clear
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-28 text-sm">Push to mute</span>
                  <Button
                    variant="outline"
                    type="button"
                    className="min-w-[220px] justify-start font-mono"
                    data-push-keybind-capture={
                      capturingKeybindField === 'pushToMuteKeybind'
                        ? 'true'
                        : undefined
                    }
                    onClick={() => startPushKeybindCapture('pushToMuteKeybind')}
                  >
                    {capturingKeybindField === 'pushToMuteKeybind'
                      ? 'Press keys...'
                      : formatPushKeybindLabel(values.pushToMuteKeybind)}
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => clearPushKeybind('pushToMuteKeybind')}
                    disabled={!values.pushToMuteKeybind}
                  >
                    Clear
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Hold the configured key to temporarily unmute (push to talk) or
                  mute (push to mute). Press Escape while capturing to cancel.
                </p>
              </div>
            </Group>
          )}
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
          <Group label="Video Codec (Webcam + Screen Share)">
            <div className="space-y-2">
              <Select
                onValueChange={(value) =>
                  onChange('videoCodec', value as VideoCodecPreference)
                }
                value={values.videoCodec}
              >
                <SelectTrigger className="w-[250px]">
                  <SelectValue placeholder="Select the video codec" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={VideoCodecPreference.AUTO}>Auto</SelectItem>
                    <SelectItem value={VideoCodecPreference.VP8}>VP8</SelectItem>
                    <SelectItem value={VideoCodecPreference.H264}>H264</SelectItem>
                    <SelectItem value={VideoCodecPreference.AV1}>
                      AV1 (experimental)
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Auto is recommended. AV1 may be unavailable on some devices, in
                which case Sharkord automatically falls back.
              </p>
            </div>
          </Group>

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
