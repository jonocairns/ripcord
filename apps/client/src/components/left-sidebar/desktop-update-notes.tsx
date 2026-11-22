import { ExternalLink } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { summarizeReleaseNotes } from '@/lib/release-notes-summary';
import type { TDesktopReleaseNoteVersion } from '@/runtime/types';

const RELEASES_URL = 'https://github.com/jonocairns/ripcord/releases';

type TDesktopUpdateNotesProps = {
	notes: TDesktopReleaseNoteVersion[];
	availableVersion?: string;
};

const DesktopUpdateNotes = memo(({ notes, availableVersion }: TDesktopUpdateNotesProps) => {
	const summary = useMemo(() => summarizeReleaseNotes(notes), [notes]);
	const versionCount = notes.length;

	const handleOpenReleases = useCallback(() => {
		window.open(RELEASES_URL, '_blank', 'noopener,noreferrer');
	}, []);

	return (
		<div className="flex max-h-[min(28rem,70vh)] flex-col gap-3">
			<div>
				<p className="text-base font-semibold text-foreground">What&apos;s new</p>
				{availableVersion && (
					<p className="text-xs text-muted-foreground">
						{versionCount > 1
							? `${versionCount} releases up to version ${availableVersion}`
							: `Version ${availableVersion}`}
					</p>
				)}
			</div>

			<ul className="min-h-0 list-disc space-y-2 overflow-y-auto pl-5 text-sm leading-snug">
				{summary.features.map((feature) => (
					<li key={`feature-${feature}`} className="font-medium text-foreground">
						{feature}
					</li>
				))}
				{summary.fixes.map((fix) => (
					<li key={`fix-${fix}`} className="text-muted-foreground">
						{fix}
					</li>
				))}
			</ul>

			{summary.hiddenCount > 0 && (
				<p className="text-sm font-medium text-foreground">
					Plus {summary.hiddenCount} more {summary.hiddenCount === 1 ? 'change' : 'changes'}.
				</p>
			)}

			<button
				type="button"
				onClick={handleOpenReleases}
				className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			>
				Full release notes
				<ExternalLink className="h-3 w-3" />
			</button>
		</div>
	);
});

export { DesktopUpdateNotes };
