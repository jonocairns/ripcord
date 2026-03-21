import { Video } from 'lucide-react';
import { memo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { CardControls } from './card-controls';
import { useScreenShareZoom } from './hooks/use-screen-share-zoom';
import { useVoiceRefs } from './hooks/use-voice-refs';
import { PinButton } from './pin-button';
import { VoiceSurface } from './voice-surface';

type TExternalVideoControlsProps = {
	isPinned: boolean;
	handlePinToggle: () => void;
	showPinControls: boolean;
};

const ExternalVideoControls = memo(({ isPinned, handlePinToggle, showPinControls }: TExternalVideoControlsProps) => {
	return (
		<CardControls>
			{showPinControls && <PinButton isPinned={isPinned} handlePinToggle={handlePinToggle} />}
		</CardControls>
	);
});

type TExternalVideoCardProps = {
	streamId: number;
	isPinned?: boolean;
	onPin: () => void;
	onUnpin: () => void;
	className?: string;
	showPinControls: boolean;
	name?: string;
};

const ExternalVideoCard = memo(
	({
		streamId,
		isPinned = false,
		onPin,
		onUnpin,
		className,
		showPinControls = true,
		name,
	}: TExternalVideoCardProps) => {
		const { externalVideoRef, hasExternalVideoStream } = useVoiceRefs(streamId);

		const {
			containerRef,
			zoom,
			position,
			isDragging,
			handleWheel,
			handleMouseDown,
			handleMouseMove,
			handleMouseUp,
			getCursor,
			resetZoom,
		} = useScreenShareZoom();

		const handlePinToggle = useCallback(() => {
			if (isPinned) {
				onUnpin?.();
				resetZoom();
			} else {
				onPin?.();
			}
		}, [isPinned, onPin, onUnpin, resetZoom]);

		if (!hasExternalVideoStream) return null;

		return (
			<VoiceSurface
				ref={containerRef}
				className={cn('relative group', 'flex items-center justify-center', 'w-full h-full', className)}
				onWheel={handleWheel}
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				onMouseLeave={handleMouseUp}
				style={{
					cursor: getCursor(),
				}}
			>
				<ExternalVideoControls
					isPinned={isPinned}
					handlePinToggle={handlePinToggle}
					showPinControls={showPinControls}
				/>

				<video
					ref={externalVideoRef}
					autoPlay
					muted
					playsInline
					className="absolute inset-0 h-full w-full bg-[#1b2026] object-contain"
					style={{
						transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
						transition: isDragging ? 'none' : 'transform 0.1s ease-out',
					}}
				/>

				<div className="absolute bottom-0 left-0 right-0 p-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
					<div className="flex items-center gap-2 min-w-0">
						<Video className="size-3.5 text-blue-400 flex-shrink-0" />
						<span className="text-white font-medium text-xs truncate">{name || 'External Video'}</span>
						{zoom > 1 && <span className="text-white/70 text-xs ml-auto flex-shrink-0">{Math.round(zoom * 100)}%</span>}
					</div>
				</div>
			</VoiceSurface>
		);
	},
);

ExternalVideoCard.displayName = 'ExternalVideoCard';

export { ExternalVideoCard };
