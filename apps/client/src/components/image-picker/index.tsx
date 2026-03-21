import type { TFile } from '@sharkord/shared';
import { Upload } from 'lucide-react';
import { memo } from 'react';
import { getFileUrl } from '@/helpers/get-file-url';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '../ui/button';

type TImagePickerProps = {
	onImageClick: () => Promise<void>;
	onRemoveImageClick?: () => Promise<void>;
	image: TFile | null;
	className?: string;
};

const ImagePicker = memo(({ onImageClick, onRemoveImageClick, image, className }: TImagePickerProps) => {
	return (
		<>
			<div className="space-y-2">
				<div
					className={cn(
						'relative group cursor-pointer w-80 h-24 overflow-hidden rounded-md border border-border/60 bg-muted/20',
						className,
					)}
					onClick={onImageClick}
				>
					{image ? (
						<img
							src={getFileUrl(image)}
							alt="Image"
							className="h-full w-full object-contain p-2 transition-opacity group-hover:opacity-70"
						/>
					) : (
						<div
							className={cn(
								buttonVariants({ variant: 'outline' }),
								'h-full w-full cursor-pointer transition-opacity group-hover:opacity-70',
							)}
						/>
					)}
					<div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
						<div className="bg-black/50 rounded-full p-3">
							<Upload className="h-6 w-6 text-white" />
						</div>
					</div>
				</div>
			</div>
			{image && (
				<div>
					<Button size="sm" variant="outline" onClick={onRemoveImageClick}>
						Remove image
					</Button>
				</div>
			)}
		</>
	);
});

export { ImagePicker };
