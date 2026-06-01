import { memo } from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { clampFramerateToResolution, getAvailableFramerates } from '@/helpers/resolution-fps-policy';
import { cn } from '@/lib/utils';
import type { Resolution } from '@/types';

type TResolutionFpsControlProps = {
	resolution: string;
	framerate: number;
	onResolutionChange: (resolution: string) => void;
	onFramerateChange: (framerate: number) => void;
	disabled?: boolean;
	className?: string;
};

const ResolutionFpsControl = memo(
	({
		resolution,
		framerate,
		onResolutionChange,
		onFramerateChange,
		disabled,
		className,
	}: TResolutionFpsControlProps) => {
		const availableFramerates = getAvailableFramerates(resolution as Resolution);

		const handleResolutionChange = (value: string) => {
			onResolutionChange(value);

			// Some framerates are not valid at every resolution (e.g. 120fps at 4K),
			// so clamp the selection down when switching to a more demanding one.
			const clamped = clampFramerateToResolution(value as Resolution, framerate);

			if (clamped !== framerate) {
				onFramerateChange(clamped);
			}
		};

		return (
			<div className={cn('grid gap-4 md:grid-cols-2', className)}>
				<div className="space-y-2">
					<Label>Resolution</Label>
					<Select value={resolution} onValueChange={handleResolutionChange} disabled={disabled}>
						<SelectTrigger className="w-full">
							<SelectValue placeholder="Select the input device" />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								<SelectItem value="144p">144p</SelectItem>
								<SelectItem value="240p">240p</SelectItem>
								<SelectItem value="360p">360p</SelectItem>
								<SelectItem value="720p">720p</SelectItem>
								<SelectItem value="1080p">1080p</SelectItem>
								<SelectItem value="1440p">1440p</SelectItem>
								<SelectItem value="2160p">2160p</SelectItem>
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-2">
					<Label>Framerate</Label>
					<Select value={framerate.toString()} onValueChange={(value) => onFramerateChange(+value)} disabled={disabled}>
						<SelectTrigger className="w-full">
							<SelectValue placeholder="Select the input device" />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{availableFramerates.map((fps) => (
									<SelectItem key={fps} value={fps.toString()}>
										{fps} fps
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>
			</div>
		);
	},
);

export default ResolutionFpsControl;
