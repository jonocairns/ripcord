import type { TDesktopReleaseNoteVersion } from './types';

// The release workflow appends `ripcordReleaseNotes` to latest.yml, built from
// CHANGELOG.md by scripts/release/desktop-update.mjs. It covers several recent
// versions so someone skipping releases still sees everything they missed.
const RELEASE_NOTES_FIELD = 'ripcordReleaseNotes';
const MAX_VERSIONS = 10;
const MAX_ITEMS_PER_LIST = 30;
const MAX_ITEM_LENGTH = 300;

type TVersionTuple = readonly [number, number, number];

const parseStableVersion = (version: string): TVersionTuple | undefined => {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) {
		return undefined;
	}

	return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const compareVersions = (left: TVersionTuple, right: TVersionTuple): number =>
	left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

const readItems = (value: unknown): string[] => {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
		.slice(0, MAX_ITEMS_PER_LIST)
		.map((item) => item.trim().slice(0, MAX_ITEM_LENGTH));
};

const readField = (value: unknown, key: string): unknown =>
	typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

// The notes are stored as a JSON string so latest.yml stays simple YAML.
const parseNotesField = (value: unknown): unknown => {
	if (typeof value !== 'string') {
		return undefined;
	}

	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
};

type TResolveReleaseNotesInput = {
	info: unknown;
	currentVersion: string;
	availableVersion: string;
};

// Returns the notes for versions newer than the running app, up to and
// including the available update, newest first.
const resolveReleaseNotes = ({
	info,
	currentVersion,
	availableVersion,
}: TResolveReleaseNotesInput): TDesktopReleaseNoteVersion[] | undefined => {
	const current = parseStableVersion(currentVersion);
	const available = parseStableVersion(availableVersion);
	const versions = readField(parseNotesField(readField(info, RELEASE_NOTES_FIELD)), 'versions');
	if (!current || !available || !Array.isArray(versions)) {
		return undefined;
	}

	const notes = versions
		.flatMap((entry): { tuple: TVersionTuple; note: TDesktopReleaseNoteVersion }[] => {
			const version = readField(entry, 'version');
			const tuple = typeof version === 'string' ? parseStableVersion(version) : undefined;
			if (typeof version !== 'string' || !tuple) {
				return [];
			}

			if (compareVersions(tuple, current) <= 0 || compareVersions(tuple, available) > 0) {
				return [];
			}

			const date = readField(entry, 'date');
			const features = readItems(readField(entry, 'features'));
			const fixes = readItems(readField(entry, 'fixes'));
			if (features.length === 0 && fixes.length === 0) {
				return [];
			}

			return [
				{
					tuple,
					note: {
						version,
						date: typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
						features,
						fixes,
					},
				},
			];
		})
		.sort((left, right) => compareVersions(right.tuple, left.tuple))
		.slice(0, MAX_VERSIONS)
		.map(({ note }) => note);

	return notes.length > 0 ? notes : undefined;
};

export { resolveReleaseNotes };
