import type { TDesktopReleaseNoteVersion } from '@/runtime/types';

type TReleaseNotesSummary = {
	features: string[];
	fixes: string[];
	hiddenCount: number;
};

const DEFAULT_VISIBLE_ITEMS = 8;

const uniqueItems = (items: string[]): string[] => [...new Set(items)];

// Combines every version the user is skipping into one list, features first,
// and reports how many items did not fit.
const summarizeReleaseNotes = (
	notes: TDesktopReleaseNoteVersion[],
	visibleItems = DEFAULT_VISIBLE_ITEMS,
): TReleaseNotesSummary => {
	const features = uniqueItems(notes.flatMap((note) => note.features));
	const fixes = uniqueItems(notes.flatMap((note) => note.fixes));
	const visibleFeatures = features.slice(0, visibleItems);
	const visibleFixes = fixes.slice(0, Math.max(0, visibleItems - visibleFeatures.length));

	return {
		features: visibleFeatures,
		fixes: visibleFixes,
		hiddenCount: features.length + fixes.length - visibleFeatures.length - visibleFixes.length,
	};
};

export { summarizeReleaseNotes };
