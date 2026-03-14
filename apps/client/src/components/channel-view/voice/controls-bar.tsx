import { useAvailableDevices } from '@/components/devices-provider/hooks/use-available-devices';
import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useChannelCan } from '@/features/server/hooks';
import { leaveVoice } from '@/features/server/voice/actions';
import { useOwnVoiceState, useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import { ChannelPermission } from '@sharkord/shared';
import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  Monitor,
  PhoneOff,
  ScreenShareOff,
  SwitchCamera,
  Video,
  VideoOff
} from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { ControlToggleButton } from './control-toggle-button';

type TControlsBarProps = {
  channelId: number;
};

const ControlsBar = memo(({ channelId }: TControlsBarProps) => {
  const {
    toggleMic,
    toggleSound,
    toggleWebcam,
    toggleScreenShare,
    connectionStatus
  } = useVoice();
  const ownVoiceState = useOwnVoiceState();
  const channelCan = useChannelCan(channelId);
  const { devices, saveDevices } = useDevices();
  const { videoDevices } = useAvailableDevices();
  const selectableVideoDevices = useMemo(
    () =>
      videoDevices.filter((device): device is MediaDeviceInfo =>
        Boolean(device?.deviceId)
      ),
    [videoDevices]
  );
  const canSwitchCamera = selectableVideoDevices.length > 1;
  const connectionNotice = useMemo(() => {
    switch (connectionStatus) {
      case 'connecting':
        return {
          className: 'border-amber-500/30 bg-amber-500/12 text-amber-300',
          label: 'Connecting'
        };
      case 'failed':
        return {
          className: 'border-red-500/30 bg-red-500/12 text-red-300',
          label: 'Issue detected'
        };
      case 'disconnected':
        return {
          className: 'border-border/80 bg-background/60 text-muted-foreground',
          label: 'Disconnected'
        };
      case 'connected':
      default:
        return undefined;
    }
  }, [connectionStatus]);

  const permissions = useMemo(
    () => ({
      canSpeak: channelCan(ChannelPermission.SPEAK),
      canWebcam: channelCan(ChannelPermission.WEBCAM),
      canShareScreen: channelCan(ChannelPermission.SHARE_SCREEN)
    }),
    [channelCan]
  );

  const switchCamera = useCallback(() => {
    if (!canSwitchCamera) {
      return;
    }

    const currentIndex = selectableVideoDevices.findIndex(
      (device) => device.deviceId === devices.webcamId
    );
    const nextIndex =
      currentIndex < 0 ? 0 : (currentIndex + 1) % selectableVideoDevices.length;
    const nextDevice = selectableVideoDevices[nextIndex];

    if (!nextDevice) {
      return;
    }

    saveDevices({
      ...devices,
      webcamId: nextDevice.deviceId
    });
  }, [canSwitchCamera, devices, saveDevices, selectableVideoDevices]);

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-full">
      <div
        className={cn(
          'rounded-lg border border-border/70 bg-card/86 p-1.5 shadow-[0_24px_60px_rgb(0_0_0/0.35)] backdrop-blur-xl',
          'supports-[backdrop-filter]:bg-card/70'
        )}
      >
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {connectionNotice && (
            <span
              className={cn(
                'rounded-full border px-2.5 py-1 text-[10px] font-medium',
                connectionNotice.className
              )}
            >
              {connectionNotice.label}
            </span>
          )}

          <div className="flex flex-wrap items-center gap-1">
            <ControlToggleButton
              enabled={ownVoiceState.micMuted}
              enabledLabel="Unmute"
              disabledLabel="Mute"
              visibleLabel="Mic"
              showLabel={false}
              enabledIcon={MicOff}
              disabledIcon={Mic}
              enabledClassName="bg-red-500/20 text-red-400 hover:bg-red-500/30 hover:text-red-300"
              onClick={toggleMic}
              disabled={!permissions.canSpeak}
            />

            <ControlToggleButton
              enabled={ownVoiceState.soundMuted}
              enabledLabel="Undeafen"
              disabledLabel="Deafen"
              visibleLabel="Sound"
              showLabel={false}
              enabledIcon={HeadphoneOff}
              disabledIcon={Headphones}
              enabledClassName="bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 hover:text-amber-300"
              onClick={toggleSound}
            />

            <ControlToggleButton
              enabled={ownVoiceState.webcamEnabled}
              enabledLabel="Stop Video"
              disabledLabel="Start Video"
              visibleLabel="Video"
              showLabel={false}
              enabledIcon={Video}
              disabledIcon={VideoOff}
              enabledClassName="bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 hover:text-emerald-300"
              onClick={toggleWebcam}
              disabled={!permissions.canWebcam}
            />

            {canSwitchCamera && (
              <Tooltip content="Switch Camera">
                <Button
                  variant="ghost"
                  className={cn(
                    'h-10 w-10 rounded-lg p-0 transition-all duration-200',
                    'hover:bg-muted/60',
                    !permissions.canWebcam && 'opacity-60 hover:bg-transparent'
                  )}
                  onClick={switchCamera}
                  disabled={!permissions.canWebcam}
                  aria-label="Switch Camera"
                >
                  <SwitchCamera size={18} />
                </Button>
              </Tooltip>
            )}

            <ControlToggleButton
              enabled={ownVoiceState.sharingScreen}
              enabledLabel="Stop Sharing"
              disabledLabel="Share Screen"
              visibleLabel="Share"
              showLabel={false}
              enabledIcon={ScreenShareOff}
              disabledIcon={Monitor}
              enabledClassName="bg-sky-500/20 text-sky-400 hover:bg-sky-500/30 hover:text-sky-300"
              onClick={toggleScreenShare}
              disabled={!permissions.canShareScreen}
            />
          </div>

          <Tooltip content="Disconnect">
            <Button
              className={cn(
                'h-10 w-10 rounded-lg p-0 text-white shadow-lg transition-all active:scale-[0.98]',
                'bg-[#ec4245] hover:bg-[#da373c]'
              )}
              onClick={leaveVoice}
              aria-label="Disconnect"
            >
              <PhoneOff size={18} fill="currentColor" />
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
});

export { ControlsBar };
