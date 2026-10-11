import { sanitizeClientTraceBatch, type TClientTraceBatch } from '@sharkord/shared';
export const createTraceRelay = (options: {
	destination: { url: string; headers: Record<string, string> };
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	now?: () => number;
}) => {
	const now = options.now ?? Date.now;
	let queue: { body: TClientTraceBatch; expiresAt: number }[] = [];
	let running: Promise<void> | undefined;
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const controller = new AbortController();
	const seen = new Map<string, number>();
	const drain = async () => {
		while (queue.length && !closed) {
			const entry = queue.shift();
			if (!entry || entry.expiresAt < now()) continue;
			for (let attempt = 0; attempt < 3 && !closed && entry.expiresAt >= now(); attempt++) {
				const request = new AbortController();
				const abort = () => request.abort();
				controller.signal.addEventListener('abort', abort, { once: true });
				const deadline = setTimeout(abort, 2000);
				try {
					const response = await new Promise<Response>((resolve, reject) => {
						const onAbort = () => reject(new Error('Trace destination timeout'));
						request.signal.addEventListener('abort', onAbort, { once: true });
						void options
							.fetch(options.destination.url, {
								method: 'POST',
								headers: { ...options.destination.headers, 'Content-Type': 'application/json' },
								body: JSON.stringify(entry.body),
								signal: request.signal,
								redirect: 'error',
							})
							.then((response) => {
								if (request.signal.aborted) {
									void response.body?.cancel().catch(() => {});
								} else resolve(response);
							}, reject)
							.finally(() => request.signal.removeEventListener('abort', onAbort));
					});
					void response.body?.cancel().catch(() => {});
					if (response.ok) break;
					if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
				} catch {
					/* Export failure cannot report itself or alter requests. */
				} finally {
					clearTimeout(deadline);
					controller.signal.removeEventListener('abort', abort);
				}
			}
		}
	};
	const start = () => {
		if (running || closed) return;
		running = drain().finally(() => {
			running = undefined;
			if (queue.length && !closed) start();
		});
	};
	return {
		accept: (batch: TClientTraceBatch, userId: number) => {
			if (closed || queue.length >= 64) return;
			for (const [key, expiresAt] of seen) if (expiresAt <= now()) seen.delete(key);
			const fresh = {
				resourceSpans: batch.resourceSpans
					.map((r) => ({
						...r,
						scopeSpans: r.scopeSpans
							.map((scope) => ({
								...scope,
								spans: scope.spans.filter((span) => {
									const age = now() - Number(BigInt(span.endTimeUnixNano) / 1_000_000n);
									if (age > 300_000 || age < -60_000) return false;
									const key = `${userId}:${span.traceId}:${span.spanId}`;
									if (seen.has(key) || seen.size >= 4096) return false;
									seen.set(key, now() + 300_000);
									return true;
								}),
							}))
							.filter((s) => s.spans.length > 0),
					}))
					.filter((r) => r.scopeSpans.length > 0),
			};
			if (!fresh.resourceSpans.length) return;
			queue.push({ body: sanitizeClientTraceBatch(fresh, userId), expiresAt: now() + 30000 });
			timer ??= setTimeout(() => {
				timer = undefined;
				start();
			}, 0);
		},
		shutdown: async () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			start();
			let deadline: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				running,
				new Promise<void>((resolve) => {
					deadline = setTimeout(resolve, 2000);
				}),
			]);
			clearTimeout(deadline);
			closed = true;
			controller.abort();
			queue = [];
		},
	};
};
