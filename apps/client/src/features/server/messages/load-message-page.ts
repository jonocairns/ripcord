import type { TJoinedMessage } from '@sharkord/shared';

type TMessagePage = {
	messages: TJoinedMessage[];
	nextCursor: number | null;
};

type TLoadMessagePageDeps = {
	query: () => Promise<TMessagePage>;
	getLoadedMessages: () => TJoinedMessage[];
	getFileLinkVersion: () => string;
	addMessages: (messages: TJoinedMessage[]) => void;
	refreshFileAccessTokens: () => Promise<void>;
};

const loadMessagePage = async (deps: TLoadMessagePageDeps): Promise<number | null> => {
	const fileLinkVersion = deps.getFileLinkVersion();
	const { messages: rawPage, nextCursor } = await deps.query();
	const existingIds = new Set(deps.getLoadedMessages().map((message) => message.id));
	const page = [...rawPage].reverse().filter((message) => !existingIds.has(message.id));

	deps.addMessages(page);

	// A rotation or rejoin refresh only reached files already loaded at the time.
	// This page may still carry older links, so refresh after adding its files.
	if (page.some((message) => message.files.length > 0) && deps.getFileLinkVersion() !== fileLinkVersion) {
		void deps.refreshFileAccessTokens();
	}

	return nextCursor;
};

export { loadMessagePage };
