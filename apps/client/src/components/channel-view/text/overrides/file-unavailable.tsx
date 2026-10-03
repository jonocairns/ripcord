import { FileX } from 'lucide-react';
import { memo } from 'react';
import { OverrideLayout } from './layout';

type TFileUnavailableProps = {
	name: string;
};

// Shown in place of an attached image, video or audio file that failed to load
// even after its link was refreshed.
const FileUnavailable = memo(({ name }: TFileUnavailableProps) => {
	return (
		<OverrideLayout>
			<div className="flex max-w-sm items-center gap-3 rounded-lg border border-dashed border-border bg-muted/40 p-2 text-muted-foreground">
				<FileX className="h-5 w-5 shrink-0" />
				<div className="flex min-w-0 flex-col">
					<span className="truncate text-sm font-medium" title={name}>
						{name}
					</span>
					<span className="text-xs">File unavailable</span>
				</div>
			</div>
		</OverrideLayout>
	);
});

export { FileUnavailable };
