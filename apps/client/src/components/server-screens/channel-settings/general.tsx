import { ChannelType } from '@sharkord/shared';
import { memo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAdminChannelGeneral } from '@/features/server/admin/hooks';

type TGeneralProps = {
	channelId: number;
};

const DEFAULT_VOICE_BITRATE = 96_000;
const DEFAULT_VOICE_FEC_PACKET_LOSS_PERC = 10;
const DEFAULT_VOICE_JITTER_BUFFER_MS = 80;

const General = memo(({ channelId }: TGeneralProps) => {
	const { channel, loading, onChange, submit, errors } = useAdminChannelGeneral(channelId);

	if (!channel) return null;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Channel Information</CardTitle>
				<CardDescription>Manage your channel's basic information</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<Group label="Name">
					<Input
						value={channel.name}
						onChange={(e) => onChange('name', e.target.value)}
						placeholder="Enter server name"
						error={errors.name}
					/>
				</Group>

				<Group label="Topic">
					<Textarea
						value={channel.topic ?? ''}
						onChange={(e) => onChange('topic', e.target.value || null)}
						placeholder="Enter channel topic"
					/>
				</Group>

				<Group label="Private" description="Restricts access to this channel to specific roles and members.">
					<Switch checked={channel.private} onCheckedChange={(value) => onChange('private', value)} />
				</Group>

				{channel.type === ChannelType.VOICE ? (
					<>
						<Group
							label="Audio Bitrate"
							description="Controls microphone Opus bitrate for this channel. Changes apply the next time users join or restart their mic."
						>
							<Select
								value={String(channel.voiceBitrate ?? DEFAULT_VOICE_BITRATE)}
								onValueChange={(value) => onChange('voiceBitrate', Number(value))}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="64000">64kbps (Standard)</SelectItem>
									<SelectItem value="96000">96kbps (High)</SelectItem>
									<SelectItem value="128000">128kbps (Studio)</SelectItem>
								</SelectContent>
							</Select>
						</Group>

						<Group
							label="FEC Packet Loss"
							description="Higher values add more loss recovery overhead for unstable networks."
						>
							<Select
								value={String(channel.voiceFecPacketLossPerc ?? DEFAULT_VOICE_FEC_PACKET_LOSS_PERC)}
								onValueChange={(value) => onChange('voiceFecPacketLossPerc', Number(value))}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="5">5% (Low)</SelectItem>
									<SelectItem value="10">10% (Moderate)</SelectItem>
									<SelectItem value="15">15% (High / WiFi)</SelectItem>
								</SelectContent>
							</Select>
						</Group>

						<Group
							label="Jitter Buffer"
							description="Sets the target playback buffer for received voice audio in this channel."
						>
							<Select
								value={String(channel.voiceJitterBufferMs ?? DEFAULT_VOICE_JITTER_BUFFER_MS)}
								onValueChange={(value) => onChange('voiceJitterBufferMs', Number(value))}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="40">40ms (Low latency)</SelectItem>
									<SelectItem value="80">80ms (Balanced)</SelectItem>
									<SelectItem value="120">120ms (Stable)</SelectItem>
									<SelectItem value="200">200ms (High latency network)</SelectItem>
								</SelectContent>
							</Select>
						</Group>
					</>
				) : null}

				<div className="flex justify-end gap-2 pt-4">
					<Button onClick={submit} disabled={loading}>
						Apply
					</Button>
				</div>
			</CardContent>
		</Card>
	);
});

export { General };
