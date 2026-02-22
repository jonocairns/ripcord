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
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { ScreenAudioMode } from '@/runtime/types';
import {
  MicQualityMode,
  Resolution,
  VideoCodecPreference,
  VoiceFilterStrength
} from '@/types';
import { Info } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MicrophoneTestPanel } from './microphone-test-panel';
import { useAvailableDevices } from './hooks/use-available-devices';
import ResolutionFpsControl from './resolution-fps-control';

const DEFAULT_NAME = 'default';
type TPushKeybindField = 'pushToTalkKeybind' | 'pushToMuteKeybind';

const Devices = memo(() => {
  const desktopBridge = getDesktopBridge();
  const hasDesktopBridge = Boolean(desktopBridge);
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const {
    inputDevices,
    videoDevices,
    loading: availableDevicesLoading
  } = useAvailableDevices();
  const { devices, saveDevices, loading: devicesLoading } = useDevices();
  const { values, onChange } = useForm(devices);
  const [desktopAppVersion, setDesktopAppVersion] = useState<string>();
  const [capturingKeybindField, setCapturingKeybindField] = useState<
    TPushKeybindField | undefined
  >(undefined);

  const saveDeviceSettings = useCallback(() => {
    saveDevices(values);
    toast.success('Device settings saved');
  }, [saveDevices, values]);

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

  useEffect(() => {
    if (!desktopBridge) {
      return;
    }

    void desktopBridge
      .getUpdateStatus()
      .then((status) => {
        setDesktopAppVersion(status.currentVersion);
      })
      .catch(() => {
        // ignore version lookup failures
      });
  }, [desktopBridge]);
  const isExperimentalMode = values.micQualityMode === MicQualityMode.EXPERIMENTAL;

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

          <div className="max-w-sm space-y-2">
            <Label>Mic quality mode</Label>
            <Select
              onValueChange={(value) =>
                onChange('micQualityMode', value as MicQualityMode)
              }
              value={values.micQualityMode}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select mic quality mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={MicQualityMode.AUTO}>Standard</SelectItem>
                  <SelectItem value={MicQualityMode.EXPERIMENTAL} disabled={!hasDesktopBridge}>
                    Experimental (Desktop)
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
            {!isExperimentalMode && (
              <div className="flex items-center justify-between gap-3">
                <Label className="cursor-default">Echo cancellation</Label>
                <Switch
                  checked={!!values.echoCancellation}
                  onCheckedChange={(checked) =>
                    onChange('echoCancellation', checked)
                  }
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <Label className="cursor-default">
                {isExperimentalMode ? 'Noise suppression (DeepFilterNet)' : 'Noise suppression'}
              </Label>
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
          </div>

          {isExperimentalMode && values.noiseSuppression && (
            <div className="max-w-sm space-y-2">
              <Label>DeepFilterNet strength</Label>
              <Select
                onValueChange={(value) =>
                  onChange('voiceFilterStrength', value as VoiceFilterStrength)
                }
                value={values.voiceFilterStrength}
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
          )}

          {isExperimentalMode ? (
            <p className="text-xs text-muted-foreground">
              Audio is captured and processed natively by the desktop sidecar. DeepFilterNet removes background noise and reverberation. Automatic gain control normalises input levels.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Uses browser-based audio processing. Echo cancellation, noise suppression, and gain control are handled by the browser.
            </p>
          )}

          <MicrophoneTestPanel
            microphoneId={values.microphoneId}
            micQualityMode={values.micQualityMode}
            voiceFilterStrength={values.voiceFilterStrength}
            echoCancellation={!!values.echoCancellation}
            noiseSuppression={!!values.noiseSuppression}
            autoGainControl={!!values.autoGainControl}
            hasDesktopBridge={hasDesktopBridge}
          />

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
                which case Ripcord automatically falls back.
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

        </section>

        {hasDesktopBridge && <Separator />}

        {hasDesktopBridge && (
          <section className="space-y-3">
            <div className="space-y-1">
              <h3 className="text-base font-semibold">Desktop</h3>
              <p className="text-sm text-muted-foreground">
                Desktop app details.
              </p>
              <p className="text-xs text-muted-foreground">
                Desktop app version:{' '}
                <span className="font-mono">
                  {desktopAppVersion || 'Unknown'}
                </span>
              </p>
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
