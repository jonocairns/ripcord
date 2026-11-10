// A first page is authoritative for the newest range. Retain older history only
// when its overlap with the page proves that there is no gap between them.
export const applyLatestMessagePage = <T extends { id: number; createdAt: number }>(loaded: T[], page: T[]) => {
	const oldest = page[0];
	const overlap = oldest ? loaded.findIndex((message) => message.id === oldest.id) : -1;
	if (overlap < 0) return { messages: page, replaced: true };

	return {
		messages: [...loaded.slice(0, overlap), ...page].sort((a, b) => a.createdAt - b.createdAt),
		replaced: false,
	};
};
