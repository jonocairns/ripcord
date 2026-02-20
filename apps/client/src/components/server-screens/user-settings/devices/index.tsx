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
  CardFooter,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingCard } from '@/components/ui/loading-card';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
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
      <CardContent className="space-y-6">
        {currentVoiceChannelId && (
          <Alert variant="default">
            <Info />
            <AlertDescription>
              You are in a voice channel, changes will only take effect after
              you leave and rejoin the channel.
            </AlertDescription>
          </Alert>
        )}
        <section className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">Microphone</h3>
            <p className="text-sm text-muted-foreground">
              Configure your input source, processing, and push-to-talk controls.
            </p>
          </div>

          <div className="max-w-2xl space-y-2">
            <Label>Input device</Label>
            <Select
              onValueChange={(value) => onChange('microphoneId', value)}
              value={values.microphoneId}
            >
              <SelectTrigger className="w-full">
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
          </div>

          <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="cursor-default">Echo cancellation</Label>
              <Switch
                checked={!!values.echoCancellation}
                onCheckedChange={(checked) =>
                  onChange('echoCancellation', checked)
                }
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label className="cursor-default">Noise suppression</Label>
              <Switch
                checked={!!values.noiseSuppression}
                onCheckedChange={(checked) =>
                  onChange('noiseSuppression', checked)
                }
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label className="cursor-default">Automatic gain control</Label>
              <Switch
                checked={!!values.autoGainControl}
                onCheckedChange={(checked) =>
                  onChange('autoGainControl', checked)
                }
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label className="cursor-default">
                Background noise filter (Desktop)
              </Label>
              <Switch
                checked={!!values.experimentalVoiceFilter}
                onCheckedChange={(checked) =>
                  onChange('experimentalVoiceFilter', checked)
                }
                disabled={!hasDesktopBridge}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Uses desktop AI noise reduction (DeepFilterNet). Higher strength
            removes more background noise but may affect voice quality. This
            filter is available in the desktop app.
          </p>

          <div className="max-w-sm space-y-2">
            <Label>Voice filter strength</Label>
            <Select
              onValueChange={(value) =>
                onChange('voiceFilterStrength', value as VoiceFilterStrength)
              }
              value={values.voiceFilterStrength}
              disabled={!hasDesktopBridge || !values.experimentalVoiceFilter}
            >
              <SelectTrigger className="w-full">
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
          </div>

          {hasDesktopBridge && (
            <div className="max-w-2xl space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Push keybinds (Desktop)</p>
                <p className="text-xs text-muted-foreground">
                  Hold the configured key to temporarily unmute (push to talk) or
                  mute (push to mute). Press Escape while capturing to cancel.
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <span className="text-sm sm:w-28">Push to talk</span>
                  <Button
                    variant="outline"
                    type="button"
                    className="w-full justify-start font-mono sm:w-[260px]"
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
                    className="sm:ml-auto"
                  >
                    Clear
                  </Button>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <span className="text-sm sm:w-28">Push to mute</span>
                  <Button
                    variant="outline"
                    type="button"
                    className="w-full justify-start font-mono sm:w-[260px]"
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
                    className="sm:ml-auto"
                  >
                    Clear
                  </Button>
                </div>
              </div>
            </div>
          )}
        </section>

        <Separator />

        <section className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">Webcam</h3>
            <p className="text-sm text-muted-foreground">
              Choose the camera and default video quality settings.
            </p>
          </div>

          <div className="max-w-2xl space-y-2">
            <Label>Input device</Label>
            <Select
              onValueChange={(value) => onChange('webcamId', value)}
              value={values.webcamId}
            >
              <SelectTrigger className="w-full">
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
          </div>

          <div className="max-w-md">
            <ResolutionFpsControl
              framerate={values.webcamFramerate}
              resolution={values.webcamResolution}
              onFramerateChange={(value) => onChange('webcamFramerate', value)}
              onResolutionChange={(value) =>
                onChange('webcamResolution', value as Resolution)
              }
            />
          </div>

          <div className="flex max-w-md items-center justify-between gap-3">
            <Label className="cursor-default">Mirror own video</Label>
            <Switch
              checked={!!values.mirrorOwnVideo}
              onCheckedChange={(checked) => onChange('mirrorOwnVideo', checked)}
            />
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">Screen Sharing</h3>
            <p className="text-sm text-muted-foreground">
              Control screen share codec, audio capture mode, and quality.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label>Video codec (Webcam + Screen Share)</Label>
              <Select
                onValueChange={(value) =>
                  onChange('videoCodec', value as VideoCodecPreference)
                }
                value={values.videoCodec}
              >
                <SelectTrigger className="w-full">
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

            <div className="space-y-2">
              <Label>Audio mode</Label>
              <Select
                onValueChange={(value) =>
                  onChange('screenAudioMode', value as ScreenAudioMode)
                }
                value={values.screenAudioMode}
              >
                <SelectTrigger className="w-full">
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
            </div>
          </div>

          <div className="max-w-md">
            <ResolutionFpsControl
              framerate={values.screenFramerate}
              resolution={values.screenResolution}
              onFramerateChange={(value) => onChange('screenFramerate', value)}
              onResolutionChange={(value) =>
                onChange('screenResolution', value as Resolution)
              }
            />
          </div>

          {hasDesktopBridge && (
            <div className="flex max-w-md items-center justify-between gap-3">
              <Label className="cursor-default">
                Use Rust sidecar capture (Experimental)
              </Label>
              <Switch
                checked={!!values.experimentalRustCapture}
                onCheckedChange={(checked) =>
                  onChange('experimentalRustCapture', checked)
                }
              />
            </div>
          )}
        </section>

        {hasDesktopBridge && <Separator />}

        {hasDesktopBridge && (
          <section className="space-y-3">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">Desktop Server URL</h3>
              <p className="text-sm text-muted-foreground">
                Set the URL used by the desktop bridge.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
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
                className="sm:w-auto"
              >
                Save URL
              </Button>
            </div>
          </section>
        )}

      </CardContent>
      <CardFooter className="border-t items-stretch justify-end gap-2 sm:items-center">
        <Button onClick={saveDeviceSettings}>Save Changes</Button>
      </CardFooter>
    </Card>
  );
});

export { Devices };
