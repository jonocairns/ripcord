import { filesize } from 'filesize';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useVoice } from '@/features/server/voice/hooks';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

type StatsPopoverProps = {
	children: React.ReactNode;
	triggerClassName?: string;
	triggerRef?: React.Ref<HTMLDivElement>;
};

const CLOSE_DELAY_MS = 120;

const formatFps = (framesPerSecond: number | null): string => {
	return framesPerSecond === null ? 'unknown' : `${Math.round(framesPerSecond)} fps`;
};

const formatResolution = (width: number | null, height: number | null): string => {
	return width === null || height === null ? 'unknown' : `${width}x${height}`;
};

const formatCodec = (codec: string | null): string => {
	return codec ?? 'unknown';
};

const formatBitrate = (bitsPerSecond: number): string => {
	if (bitsPerSecond >= 1_000_000) {
		return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
	}

	return `${Math.round(bitsPerSecond / 1000)} kbps`;
};

const StatsPopover = memo(({ children, triggerClassName, triggerRef }: StatsPopoverProps) => {
	const { transportStats } = useVoice();
	const [open, setOpen] = useState(false);
	const closeTimeoutRef = useRef<number | undefined>(undefined);

	const { producer, consumer, totalBytesSent, totalBytesReceived, currentBitrateSent, currentBitrateReceived } =
		transportStats;

	const clearCloseTimeout = useCallback(() => {
		if (closeTimeoutRef.current === undefined) {
			return;
		}

		window.clearTimeout(closeTimeoutRef.current);
		closeTimeoutRef.current = undefined;
	}, []);

	const handleOpen = useCallback(() => {
		clearCloseTimeout();
		setOpen(true);
	}, [clearCloseTimeout]);

	const handleClose = useCallback(() => {
		clearCloseTimeout();
		closeTimeoutRef.current = window.setTimeout(() => {
			setOpen(false);
			closeTimeoutRef.current = undefined;
		}, CLOSE_DELAY_MS);
	}, [clearCloseTimeout]);

	useEffect(() => {
		return () => {
			clearCloseTimeout();
		};
	}, [clearCloseTimeout]);

	return (
		<Popover open={open}>
			<PopoverTrigger asChild>
				<div ref={triggerRef} className={triggerClassName} onMouseEnter={handleOpen} onMouseLeave={handleClose}>
					{children}
				</div>
			</PopoverTrigger>
			<PopoverContent side="top" align="start" className="p-0" onMouseEnter={handleOpen} onMouseLeave={handleClose}>
				<div className="w-72 p-3 text-xs">
					<h3 className="font-semibold text-sm mb-2 text-foreground">Transport Statistics</h3>
					<div className="grid grid-cols-2 gap-4 mb-3">
						<div>
							<h4 className="font-medium text-green-400 mb-1">Outgoing</h4>
							{producer ? (
								<div className="space-y-1 text-muted-foreground">
									<div>Rate: {formatBitrate(currentBitrateSent)}</div>
									<div>RTT: {producer.rtt.toFixed(1)} ms</div>
								</div>
							) : (
								<div className="text-muted-foreground">No data</div>
							)}
						</div>

						<div>
							<h4 className="font-medium text-blue-400 mb-1">Incoming</h4>
							{consumer ? (
								<div className="space-y-1 text-muted-foreground">
									<div>Rate: {formatBitrate(currentBitrateReceived)}</div>
								</div>
							) : (
								<div className="text-muted-foreground">No remote streams</div>
							)}
						</div>
					</div>
					{producer?.outboundVideo.length ? (
						<div className="border-t border-border/50 pt-2">
							<h4 className="font-medium text-green-400 mb-1">Video Send</h4>
							<div className="space-y-2 text-muted-foreground">
								{producer.outboundVideo.map((video, index) => (
									<div key={video.id} className="space-y-0.5">
										<div className="font-medium text-foreground/80">Stream {index + 1}</div>
										<div>
											{formatCodec(video.codec)} · {formatResolution(video.width, video.height)} ·{' '}
											{formatFps(video.framesPerSecond)}
										</div>
										{(video.encoderImplementation || video.powerEfficientEncoder !== null) && (
											<div>
												Encoder: {video.encoderImplementation || 'unknown'}
												{video.powerEfficientEncoder !== null && (
													<span className={video.powerEfficientEncoder ? ' text-green-400' : ' text-amber-400'}>
														{' '}
														({video.powerEfficientEncoder ? 'hardware' : 'software'})
													</span>
												)}
											</div>
										)}
										{video.framesDropped !== null && <div>Dropped: {video.framesDropped}</div>}
										<div>Limit: {video.qualityLimitationReason ?? 'none'}</div>
									</div>
								))}
							</div>
						</div>
					) : null}
					{consumer?.inboundVideo.length ? (
						<div className="border-t border-border/50 pt-2">
							<h4 className="font-medium text-blue-400 mb-1">Video Receive</h4>
							<div className="space-y-2 text-muted-foreground">
								{consumer.inboundVideo.map((video, index) => (
									<div key={video.id} className="space-y-0.5">
										<div className="font-medium text-foreground/80">Stream {index + 1}</div>
										<div>
											{formatCodec(video.codec)} · {formatResolution(video.width, video.height)} ·{' '}
											{formatFps(video.framesPerSecond)}
										</div>
										{video.framesDropped !== null && <div>Dropped: {video.framesDropped}</div>}
										<div>Packets lost: {video.packetsLost}</div>
									</div>
								))}
							</div>
						</div>
					) : null}
					<div className="border-t border-border/50 pt-2">
						<h4 className="font-medium text-yellow-400 mb-1">Session Totals</h4>
						<div className="grid grid-cols-2 gap-2 text-muted-foreground">
							<div>↑ {filesize(totalBytesSent)}</div>
							<div>↓ {filesize(totalBytesReceived)}</div>
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
});

export { StatsPopover };
