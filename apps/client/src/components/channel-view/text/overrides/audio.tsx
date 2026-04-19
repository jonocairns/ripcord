import {
	MediaPlayer,
	type MediaPlayerInstance,
	MediaProvider,
	MuteButton,
	PlayButton,
	Time,
	TimeSlider,
	useMediaRemote,
	useMediaState,
	VolumeSlider,
} from '@vidstack/react';
import { filesize } from 'filesize';
import { ExternalLink, MoreHorizontal, Pause, Play, Trash, Volume1, Volume2, VolumeX } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { OverrideLayout } from './layout';
import { useSyncSharedMediaPreferences } from './shared-media-preferences';

import '@vidstack/react/player/styles/default/theme.css';

type TAudioOverrideProps = {
	src: string;
	name: string;
	size?: number;
	href?: string;
	onRemove?: () => void;
};

const playbackRates = [1, 1.25, 1.5, 2];
const BAR_COUNT = 48;

const formatPlaybackRate = (rate: number) => `${Number(rate.toFixed(2))}x`;

const hashString = (s: string) => {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
};

const generateBars = (seed: string, count: number) => {
	let state = hashString(seed) || 1;
	const bars: number[] = [];
	for (let i = 0; i < count; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const norm = (state % 1000) / 1000;
		const envelope = 0.55 + 0.45 * Math.sin((i / Math.max(count - 1, 1)) * Math.PI);
		bars.push(Math.max(0.2, Math.min(1, 0.25 + 0.85 * norm * envelope)));
	}
	return bars;
};

const Waveform = memo(({ bars, className }: { bars: number[]; className: string }) => {
	return (
		<div className={`pointer-events-none absolute inset-0 flex items-center gap-[2px] ${className}`}>
			{bars.map((height, index) => (
				<div key={index} className="flex-1 rounded-full bg-current" style={{ height: `${height * 100}%` }} />
			))}
		</div>
	);
});

const AudioPlayerChrome = memo(
	({ name, size, href, onRemove, bars }: Omit<TAudioOverrideProps, 'src'> & { bars: number[] }) => {
		const isPaused = useMediaState('paused');
		const isMuted = useMediaState('muted');
		const volume = useMediaState('volume');
		const playbackRate = useMediaState('playbackRate');
		const currentTime = useMediaState('currentTime');
		const duration = useMediaState('duration');
		const remote = useMediaRemote();

		const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;

		const volumeIcon = useMemo(() => {
			if (isMuted || volume === 0) return <VolumeX className="h-4 w-4" />;
			if (volume < 0.5) return <Volume1 className="h-4 w-4" />;
			return <Volume2 className="h-4 w-4" />;
		}, [isMuted, volume]);

		const onPlaybackRateClick = useCallback(() => {
			const currentIndex = playbackRates.findIndex((rate) => Math.abs(rate - playbackRate) < 0.01);
			const nextRate = playbackRates[(currentIndex + 1 + playbackRates.length) % playbackRates.length];
			remote.changePlaybackRate(nextRate);
		}, [playbackRate, remote]);

		return (
			<div className="w-full max-w-[560px] rounded-lg border border-border/80 bg-secondary/80 p-3 shadow-sm">
				<div className="flex items-center gap-3">
					<PlayButton
						className="group/play flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md ring-1 ring-primary/40 transition-all hover:scale-105 hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/60"
						aria-label={isPaused ? 'Play audio' : 'Pause audio'}
					>
						{isPaused ? (
							<Play className="h-4 w-4 translate-x-px fill-current" />
						) : (
							<Pause className="h-4 w-4 fill-current" />
						)}
					</PlayButton>

					<div className="min-w-0 flex-1">
						<TimeSlider.Root
							className="group/slider relative flex h-8 w-full cursor-pointer touch-none select-none items-center"
							aria-label="Seek audio"
						>
							<TimeSlider.Track className="relative h-full w-full overflow-hidden rounded-sm">
								<Waveform bars={bars} className="text-muted-foreground/30" />
								<div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${progress * 100}%` }}>
									<div className="relative h-full" style={{ width: `${100 / Math.max(progress, 0.0001)}%` }}>
										<Waveform bars={bars} className="text-primary" />
									</div>
								</div>
								<TimeSlider.Progress className="hidden" />
								<TimeSlider.TrackFill className="hidden" />
							</TimeSlider.Track>
						</TimeSlider.Root>

						<div className="mt-1 flex items-center justify-between gap-2 text-[11px] leading-4 tabular-nums text-muted-foreground">
							<div className="flex min-w-0 items-center gap-1.5">
								{href ? (
									<a
										href={href}
										target="_blank"
										rel="noopener"
										className="truncate font-medium text-foreground hover:underline"
										title={name}
									>
										{name}
									</a>
								) : (
									<span className="truncate font-medium text-foreground" title={name}>
										{name}
									</span>
								)}
								{typeof size === 'number' && (
									<>
										<span aria-hidden="true">·</span>
										<span className="shrink-0">{filesize(size)}</span>
									</>
								)}
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<Time type="current" />
								<span aria-hidden="true">/</span>
								<Time type="duration" />
							</div>
						</div>
					</div>

					<div className="group/vol flex shrink-0 items-center">
						<MuteButton
							className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
							aria-label={isMuted || volume === 0 ? 'Unmute audio' : 'Mute audio'}
						>
							{volumeIcon}
						</MuteButton>
						<div className="grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-hover/vol:grid-cols-[1fr] focus-within:grid-cols-[1fr]">
							<div className="min-w-0 overflow-hidden">
								<VolumeSlider.Root
									className="relative ml-1 flex h-6 w-16 cursor-pointer touch-none select-none items-center"
									aria-label="Audio volume"
								>
									<VolumeSlider.Track className="relative h-1 w-full overflow-hidden rounded-full bg-border/80">
										<VolumeSlider.TrackFill className="absolute inset-y-0 left-0 rounded-full bg-foreground/70" />
									</VolumeSlider.Track>
									<VolumeSlider.Thumb
										className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow-sm"
										style={{ left: 'var(--slider-fill, 0%)' }}
									/>
								</VolumeSlider.Root>
							</div>
						</div>
					</div>

					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								className="h-8 w-8 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
								aria-label="Audio options"
							>
								<MoreHorizontal className="h-4 w-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							<DropdownMenuItem onSelect={onPlaybackRateClick}>
								<span className="flex-1">Speed</span>
								<span className="text-xs tabular-nums text-muted-foreground">{formatPlaybackRate(playbackRate)}</span>
							</DropdownMenuItem>
							{href && (
								<DropdownMenuItem asChild>
									<a href={href} target="_blank" rel="noopener">
										<ExternalLink className="h-3.5 w-3.5" />
										<span>Open in new tab</span>
									</a>
								</DropdownMenuItem>
							)}
							{onRemove && (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem variant="destructive" onSelect={onRemove}>
										<Trash className="h-3.5 w-3.5" />
										<span>Delete</span>
									</DropdownMenuItem>
								</>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
		);
	},
);

const AudioOverride = memo(({ src, name, size, href, onRemove }: TAudioOverrideProps) => {
	const [error, setError] = useState(false);
	const playerRef = useRef<MediaPlayerInstance>(null);

	const onError = useCallback(() => {
		setError(true);
	}, []);

	const bars = useMemo(() => generateBars(src || name, BAR_COUNT), [src, name]);
	const mediaPreferences = useSyncSharedMediaPreferences(playerRef);

	if (error) return null;

	return (
		<OverrideLayout>
			<MediaPlayer
				ref={playerRef}
				src={src}
				load="visible"
				viewType="audio"
				storage="ripcord-media"
				onError={onError}
				title={name}
				volume={mediaPreferences.volume}
				muted={mediaPreferences.muted}
				className="w-full max-w-[560px]"
			>
				<MediaProvider />
				<AudioPlayerChrome name={name} size={size} href={href} onRemove={onRemove} bars={bars} />
			</MediaPlayer>
		</OverrideLayout>
	);
});

export { AudioOverride };
