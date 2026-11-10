// Cached membership cannot establish continuity across an outage. Use the full
// authoritative page, then replay request-time live mutations before publishing.
export const applyLatestMessagePage = <T extends { id: number; createdAt: number }>(_loaded: T[], page: T[]) => ({
	messages: [...page].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id),
	replaced: true,
});
