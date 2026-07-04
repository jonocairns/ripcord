import { Loader2, Monitor } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { CardGradient } from './card-gradient';
import { VoiceSurface } from './voice-surface';

type TStartingScreenShareCardProps = {
	className?: string;
};

const StartingScreenShareCard = memo(({ className }: TStartingScreenShareCardProps) => {
	return (
		<VoiceSurface className={cn('relative flex h-full w-full items-center justify-center', className)}>
			<CardGradient />

			<div className="relative z-10 flex max-w-md flex-col items-center gap-4 px-6 py-8 text-center">
				<div className="flex size-20 items-center justify-center rounded-full border border-white/10 bg-black/35">
					<Monitor className="size-8 text-live-screen" />
				</div>

				<div className="inline-flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-white/70">
					<Loader2 className="size-3.5 animate-spin" />
					<span>Starting</span>
				</div>

				<div className="space-y-1">
					<p className="text-lg font-semibold text-white">Starting screen share...</p>
					<p className="text-sm text-white/70">Your preview will appear here in a moment.</p>
				</div>
			</div>
		</VoiceSurface>
	);
});

StartingScreenShareCard.displayName = 'StartingScreenShareCard';

export { StartingScreenShareCard };
