import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { LoaderCircle, Tv } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TIptvConfigDialogProps = {
  channelId: number;
};

const IptvConfigDialog = memo(({ channelId }: TIptvConfigDialogProps) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [alwaysTranscodeVideo, setAlwaysTranscodeVideo] = useState(false);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    const trpc = getTRPCClient();

    try {
      const config = await trpc.iptv.getConfig.query({ channelId });

      setConfigured(!!config);
      setPlaylistUrl(config?.playlistUrl ?? '');
      setEnabled(config?.enabled ?? true);
      setAlwaysTranscodeVideo(config?.alwaysTranscodeVideo ?? false);
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to fetch IPTV configuration'));
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  const saveConfig = useCallback(async () => {
    if (!playlistUrl.trim()) {
      toast.error('Playlist URL is required');
      return;
    }

    setSaving(true);
    const trpc = getTRPCClient();

    try {
      await trpc.iptv.configure.mutate({
        channelId,
        playlistUrl: playlistUrl.trim(),
        enabled,
        alwaysTranscodeVideo
      });

      toast.success('IPTV configuration saved');
      setConfigured(true);
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to save IPTV configuration'));
    } finally {
      setSaving(false);
    }
  }, [alwaysTranscodeVideo, channelId, enabled, playlistUrl]);

  const removeConfig = useCallback(async () => {
    setSaving(true);
    const trpc = getTRPCClient();

    try {
      await trpc.iptv.remove.mutate({ channelId });
      setConfigured(false);
      setPlaylistUrl('');
      setEnabled(true);
      setAlwaysTranscodeVideo(false);
      toast.success('IPTV configuration removed');
      setOpen(false);
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to remove IPTV configuration'));
    } finally {
      setSaving(false);
    }
  }, [channelId]);

  const testPlaylist = useCallback(async () => {
    if (!playlistUrl.trim()) {
      toast.error('Playlist URL is required to test');
      return;
    }

    setTesting(true);
    const trpc = getTRPCClient();

    try {
      const channels = await trpc.iptv.listChannels.query({
        channelId,
        playlistUrl: playlistUrl.trim()
      });

      toast.success(`Playlist is valid (${channels.length} channels found)`);
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to test IPTV playlist'));
    } finally {
      setTesting(false);
    }
  }, [channelId, playlistUrl]);

  useEffect(() => {
    if (!open) {
      return;
    }

    void fetchConfig();
  }, [fetchConfig, open]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>IPTV</CardTitle>
        <CardDescription>
          Configure an M3U8 playlist for this voice channel.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {configured
              ? 'IPTV is configured for this channel.'
              : 'No IPTV source configured yet.'}
          </p>
          <Button onClick={() => setOpen(true)} variant="secondary">
            <Tv className="size-4" />
            Configure IPTV
          </Button>
        </div>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent close={() => setOpen(false)}>
          <DialogHeader>
            <DialogTitle>IPTV Configuration</DialogTitle>
            <DialogDescription>
              Set the playlist URL and enable or disable IPTV for this voice
              channel.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : (
            <div className="space-y-4">
              <Group label="Playlist URL">
                <Input
                  value={playlistUrl}
                  onChange={(event) => setPlaylistUrl(event.target.value)}
                  placeholder="https://example.com/playlist.m3u8"
                />
              </Group>
              <Group
                label="Enabled"
                description="When disabled, IPTV playback controls are unavailable."
              >
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </Group>
              <Group
                label="Always transcode video"
                description="Higher CPU usage, but more consistent quality and frame pacing than copy mode."
              >
                <Switch
                  checked={alwaysTranscodeVideo}
                  onCheckedChange={setAlwaysTranscodeVideo}
                />
              </Group>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => void testPlaylist()}
              disabled={loading || saving || testing}
            >
              {testing && <LoaderCircle className="size-4 animate-spin" />}
              Test
            </Button>

            {configured && (
              <Button
                variant="destructive"
                onClick={() => void removeConfig()}
                disabled={loading || saving || testing}
              >
                Remove
              </Button>
            )}

            <Button
              onClick={() => void saveConfig()}
              disabled={loading || saving || testing}
            >
              {saving && <LoaderCircle className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
});

export { IptvConfigDialog };
