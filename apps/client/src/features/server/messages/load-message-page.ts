import type { TJoinedMessage } from '@sharkord/shared';

type TMessagePage = {
	messages: TJoinedMessage[];
	nextCursor: number | null;
};

type TLoadMessagePageDeps = {
	query: () => Promise<TMessagePage>;
	isCurrent?: () => boolean;
	getLoadedMessages: () => TJoinedMessage[];
	getFileLinkVersion: () => string;
	applyLatestMessagePage?: (messages: TJoinedMessage[]) => void;
	addMessages: (messages: TJoinedMessage[]) => void;
	refreshFileAccessTokens: () => Promise<void>;
};

const loadMessagePage = async (deps: TLoadMessagePageDeps): Promise<number | null> => {
	const fileLinkVersion = deps.getFileLinkVersion();
	const { messages: rawPage, nextCursor } = await deps.query();
	if (deps.isCurrent && !deps.isCurrent()) return nextCursor;
	const existingIds = new Set(deps.getLoadedMessages().map((message) => message.id));
	const oldestFirst = [...rawPage].reverse();
	const page = deps.applyLatestMessagePage
		? oldestFirst
		: oldestFirst.filter((message) => !existingIds.has(message.id));

	if (deps.applyLatestMessagePage) deps.applyLatestMessagePage(page);
	else deps.addMessages(page);

	// A rotation or rejoin refresh only reached files already loaded at the time.
	// This page may still carry older links, so refresh after adding its files.
	if (page.some((message) => message.files.length > 0) && deps.getFileLinkVersion() !== fileLinkVersion) {
		void deps.refreshFileAccessTokens();
	}

	return nextCursor;
};

export { loadMessagePage };
