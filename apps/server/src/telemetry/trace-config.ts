export const parseTraceDestination = (
	endpoint: string,
	headerText: string,
): { url: string; headers: Record<string, string> } | undefined => {
	try {
		if (!endpoint.trim()) return undefined;
		const url = new URL(endpoint.trim());
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search)
			return undefined;
		const value: unknown = headerText.trim() ? JSON.parse(headerText) : {};
		if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
		const headers: Record<string, string> = {};
		const entries = Object.entries(value);
		if (entries.length > 10) return undefined;
		for (const [key, v] of entries) {
			if (
				!/^[a-zA-Z0-9-]{1,80}$/.test(key) ||
				typeof v !== 'string' ||
				v.length > 1000 ||
				/[\r\n]/.test(v) ||
				/^(host|content-length|content-type)$/i.test(key)
			)
				return undefined;
			headers[key] = v;
		}
		return { url: url.href, headers };
	} catch {
		return undefined;
	}
};
