import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import {
  formatPushKeybindLabel,
  pushKeybindFromKeyState
} from '@/components/devices-provider/push-keybind';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { LoadingCard } from '@/components/ui/loading-card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useForm } from '@/hooks/use-form';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { ScreenAudioMode } from '@/runtime/types';
import { Resolution, VideoCodecPreference } from '@/types';
import { Info, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAvailableDevices } from './hooks/use-available-devices';
import { MicrophoneTestPanel } from './microphone-test-panel';
import ResolutionFpsControl from './resolution-fps-control';

const DEFAULT_NAME = 'default';
type TPushKeybindField = 'pushToTalkKeybind' | 'pushToMuteKeybind';

const getDefaultDeviceId = (
  availableDevices: (MediaDeviceInfo | undefined)[]
): string | undefined => {
  const device = availableDevices.find(
    (candidate): candidate is MediaDeviceInfo => Boolean(candidate)
  );

  if (!device) {
    return undefined;
  }

  return device.deviceId || DEFAULT_NAME;
};

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
  const { values, onChange, setValues } = useForm(devices);
  const lastLoadedDevicesRef = useRef(devices);
  const [desktopAppVersion, setDesktopAppVersion] = useState<string>();
  const [capturingKeybindField, setCapturingKeybindField] = useState<
    TPushKeybindField | undefined
  >(undefined);
  const defaultMicrophoneId = getDefaultDeviceId(inputDevices);
  const defaultWebcamId = getDefaultDeviceId(videoDevices);
  const selectedMicrophoneId = values.microphoneId || defaultMicrophoneId;
  const selectedWebcamId = values.webcamId || defaultWebcamId;

  const saveDeviceSettings = useCallback(() => {
    saveDevices({
      ...values,
      microphoneId: selectedMicrophoneId,
      webcamId: selectedWebcamId
    });
    toast.success('Device settings saved');
  }, [saveDevices, selectedMicrophoneId, selectedWebcamId, values]);

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
        toast.error(
          'Push-to-talk and push-to-mute cannot use the same keybind'
        );
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

  useEffect(() => {
    if (hasDesktopBridge) {
      return;
    }

    if (values.screenAudioMode === ScreenAudioMode.APP) {
      onChange('screenAudioMode', ScreenAudioMode.SYSTEM);
    }
  }, [hasDesktopBridge, onChange, values.screenAudioMode]);

  useEffect(() => {
    setValues((currentValues) => {
      if (lastLoadedDevicesRef.current !== devices) {
        lastLoadedDevicesRef.current = devices;

        return {
          ...devices,
          microphoneId: devices.microphoneId || defaultMicrophoneId,
          webcamId: devices.webcamId || defaultWebcamId
        };
      }

      const nextMicrophoneId =
        currentValues.microphoneId || defaultMicrophoneId;
      const nextWebcamId = currentValues.webcamId || defaultWebcamId;

      if (
        nextMicrophoneId === currentValues.microphoneId &&
        nextWebcamId === currentValues.webcamId
      ) {
        return currentValues;
      }

      return {
        ...currentValues,
        microphoneId: nextMicrophoneId,
        webcamId: nextWebcamId
      };
    });
  }, [defaultMicrophoneId, defaultWebcamId, devices, setValues]);

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
              Saved microphone and webcam changes apply immediately while you
              stay connected. Screen share changes apply the next time you start
              sharing.
            </AlertDescription>
          </Alert>
        )}
        <section className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">Microphone</h3>
            <p className="text-sm text-muted-foreground">
              Configure your input source, audio cleanup, and push-to-talk
              controls.
            </p>
          </div>

          <div className=" space-y-2">
            <Label>Input device</Label>
            <Select
              onValueChange={(value) => onChange('microphoneId', value)}
              value={selectedMicrophoneId}
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

          <Alert variant="info" className="border-primary/40 bg-primary/10">
            <Info />
            <AlertTitle>NVIDIA Broadcast Recommended</AlertTitle>
            <AlertDescription className="block text-foreground/90">
              Using an NVIDIA GPU? Install{' '}
              <strong className="font-semibold text-foreground">
                NVIDIA Broadcast
              </strong>{' '}
              for clearer microphone voice processing.
            </AlertDescription>
          </Alert>

          <div className="grid gap-x-8 gap-y-3 md:grid-cols-2 my-4 pl-2">
            <div className="flex items-center gap-3">
              <Switch
                checked={!!values.echoCancellation}
                onCheckedChange={(checked) =>
                  onChange('echoCancellation', checked)
                }
              />
              <Label className="cursor-default">Echo cancellation</Label>
            </div>

            <div className="flex items-center gap-3">
              <Switch
                checked={!!values.noiseSuppression}
                onCheckedChange={(checked) =>
                  onChange('noiseSuppression', checked)
                }
              />
              <Label className="cursor-default">Noise suppression</Label>
            </div>

            <div className="flex items-center gap-3">
              <Switch
                checked={!!values.autoGainControl}
                onCheckedChange={(checked) =>
                  onChange('autoGainControl', checked)
                }
              />
              <Label className="cursor-default">Automatic gain control</Label>
            </div>
          </div>

          <MicrophoneTestPanel
            microphoneId={selectedMicrophoneId}
            micQualityMode={values.micQualityMode}
            voiceFilterStrength={values.voiceFilterStrength}
            echoCancellation={!!values.echoCancellation}
            noiseSuppression={!!values.noiseSuppression}
            autoGainControl={!!values.autoGainControl}
            hasDesktopBridge={hasDesktopBridge}
          />

          {hasDesktopBridge && (
            <div className=" space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Push keybinds (Desktop)</p>
                <p className="text-xs text-muted-foreground">
                  Hold the configured key to temporarily unmute (push to talk)
                  or mute (push to mute). <br />
                  Press Escape while capturing to cancel.
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Label className="w-24 shrink-0 text-sm">Push to talk</Label>
                  <div className="flex items-center">
                    <Button
                      variant="outline"
                      type="button"
                      className={`min-w-[140px] justify-start rounded-r-none border-r-0 font-mono text-xs${
                        capturingKeybindField === 'pushToTalkKeybind'
                          ? ' ring-2 ring-ring'
                          : ''
                      }`}
                      data-push-keybind-capture={
                        capturingKeybindField === 'pushToTalkKeybind'
                          ? 'true'
                          : undefined
                      }
                      onClick={() =>
                        startPushKeybindCapture('pushToTalkKeybind')
                      }
                    >
                      {capturingKeybindField === 'pushToTalkKeybind'
                        ? 'Press keys...'
                        : formatPushKeybindLabel(values.pushToTalkKeybind)}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0 rounded-l-none"
                      onClick={() => clearPushKeybind('pushToTalkKeybind')}
                      disabled={!values.pushToTalkKeybind}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Label className="w-24 shrink-0 text-sm">Push to mute</Label>
                  <div className="flex items-center">
                    <Button
                      variant="outline"
                      type="button"
                      className={`min-w-[140px] justify-start rounded-r-none border-r-0 font-mono text-xs${
                        capturingKeybindField === 'pushToMuteKeybind'
                          ? ' ring-2 ring-ring'
                          : ''
                      }`}
                      data-push-keybind-capture={
                        capturingKeybindField === 'pushToMuteKeybind'
                          ? 'true'
                          : undefined
                      }
                      onClick={() =>
                        startPushKeybindCapture('pushToMuteKeybind')
                      }
                    >
                      {capturingKeybindField === 'pushToMuteKeybind'
                        ? 'Press keys...'
                        : formatPushKeybindLabel(values.pushToMuteKeybind)}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-9 w-9 shrink-0 rounded-l-none"
                      onClick={() => clearPushKeybind('pushToMuteKeybind')}
                      disabled={!values.pushToMuteKeybind}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
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

          <div className=" space-y-2">
            <Label>Input device</Label>
            <Select
              onValueChange={(value) => onChange('webcamId', value)}
              value={selectedWebcamId}
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

          <div>
            <ResolutionFpsControl
              framerate={values.webcamFramerate}
              resolution={values.webcamResolution}
              onFramerateChange={(value) => onChange('webcamFramerate', value)}
              onResolutionChange={(value) =>
                onChange('webcamResolution', value as Resolution)
              }
            />
          </div>

          <div className="flex items-center gap-3 pl-2">
            <Switch
              checked={!!values.mirrorOwnVideo}
              onCheckedChange={(checked) => onChange('mirrorOwnVideo', checked)}
            />
            <Label className="cursor-default">Mirror own video</Label>
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
                    <SelectItem value={VideoCodecPreference.AUTO}>
                      Auto
                    </SelectItem>
                    <SelectItem value={VideoCodecPreference.VP8}>
                      VP8
                    </SelectItem>
                    <SelectItem value={VideoCodecPreference.H264}>
                      H264
                    </SelectItem>
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
                    <SelectItem
                      value={ScreenAudioMode.APP}
                      disabled={!hasDesktopBridge}
                    >
                      Per-app audio
                    </SelectItem>
                    <SelectItem value={ScreenAudioMode.NONE}>
                      No shared audio
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              {!hasDesktopBridge && (
                <p className="text-xs text-muted-foreground">
                  Per-app audio is only available in the desktop app.
                </p>
              )}
            </div>
          </div>

          <div>
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
      <CardFooter className="items-stretch justify-end gap-2 sm:items-center">
        <Button onClick={saveDeviceSettings}>Apply</Button>
      </CardFooter>
    </Card>
  );
});

export { Devices };
