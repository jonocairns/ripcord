import { Hash } from 'lucide-react';
import { memo } from 'react';
import { useChannelById } from '@/features/server/channels/hooks';

type TChannelHeaderProps = {
	channelId: number;
};

const ChannelHeader = memo(({ channelId }: TChannelHeaderProps) => {
	const channel = useChannelById(channelId);

	if (!channel) return null;

	return (
		<div className="elevated-bar flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
			<Hash className="h-5 w-5 shrink-0 text-muted-foreground" />
			<span className="shrink-0 truncate font-semibold text-foreground">{channel.name}</span>
			{channel.topic && (
				<>
					<span aria-hidden className="h-4 w-px shrink-0 bg-border" />
					<span className="min-w-0 truncate text-sm text-muted-foreground">{channel.topic}</span>
				</>
			)}
		</div>
	);
});

export { ChannelHeader };
