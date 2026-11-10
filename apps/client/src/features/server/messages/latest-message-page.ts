// Cached membership cannot establish continuity across an outage.
export const sortLatestMessagePage = <T extends { id: number; createdAt: number }>(page: T[]) =>
	[...page].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
