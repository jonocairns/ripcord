import { sanitizeClientTraceBatch, type TClientTraceBatch } from '@sharkord/shared';
import type { telemetryHealth } from './health';
export const createTraceRelay = (options: {
	destination: { url: string; headers: Record<string, string> };
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	now?: () => number;
	health?: Pick<typeof telemetryHealth, 'count'>;
}) => {
	const now = options.now ?? Date.now;
	const count: NonNullable<typeof options.health>['count'] = (reason, quantity = 1) => {
		try {
			options.health?.count(reason, quantity);
		} catch {
			/* Optional health cannot alter delivery. */
		}
	};
	let activeBatch = false;
	let queue: { body: TClientTraceBatch; expiresAt: number }[] = [];
	let running: Promise<void> | undefined;
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const controller = new AbortController();
	const seen = new Map<string, number>();
	const drain = async () => {
		while (queue.length && !closed) {
			const entry = queue.shift();
			if (!entry) continue;
			if (entry.expiresAt < now()) {
				count('trace_relay_queue_expired');
				continue;
			}
			activeBatch = true;
			let delivered = false;
			for (let attempt = 0; attempt < 3 && !closed && entry.expiresAt >= now(); attempt++) {
				if (attempt > 0) count('trace_relay_retry');
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
					if (response.ok) {
						delivered = true;
						break;
					}
					count('trace_relay_export_failure');
					if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
				} catch {
					if (!closed) count('trace_relay_export_failure');
				} finally {
					clearTimeout(deadline);
					controller.signal.removeEventListener('abort', abort);
				}
			}
			if (!delivered && !closed)
				count(entry.expiresAt < now() ? 'trace_relay_queue_expired' : 'trace_relay_failed_batch');
			activeBatch = false;
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
			if (closed) return;
			for (const [key, expiresAt] of seen) if (expiresAt <= now()) seen.delete(key);
			const freshKeys = new Set<string>();
			const fresh = {
				resourceSpans: batch.resourceSpans
					.map((r) => ({
						...r,
						scopeSpans: r.scopeSpans
							.map((scope) => ({
								...scope,
								spans: scope.spans.filter((span) => {
									const key = `${userId}:${span.traceId}:${span.spanId}`;
									if (seen.has(key) || freshKeys.has(key)) return false;
									const age = now() - Number(BigInt(span.endTimeUnixNano) / 1_000_000n);
									if (age > 300_000) {
										count('trace_relay_stale');
										return false;
									}
									if (age < -60_000) {
										count('trace_relay_future');
										return false;
									}
									freshKeys.add(key);
									return true;
								}),
							}))
							.filter((s) => s.spans.length > 0),
					}))
					.filter((r) => r.scopeSpans.length > 0),
			};
			if (!fresh.resourceSpans.length) return;
			if (queue.length >= 64) {
				count('trace_relay_queue_full');
				return;
			}
			for (const key of freshKeys) {
				if (seen.size >= 4096) {
					const oldest = seen.keys().next().value;
					if (oldest !== undefined) seen.delete(oldest);
				}
				seen.set(key, now() + 300_000);
			}
			queue.push({ body: sanitizeClientTraceBatch(fresh, userId), expiresAt: now() + 30000 });
			timer ??= setTimeout(() => {
				timer = undefined;
				start();
			}, 0);
		},
		shutdown: async () => {
			if (closed) return;
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
			const dropped = queue.length + (activeBatch ? 1 : 0);
			if (dropped) count('trace_relay_shutdown_drop', dropped);
			controller.abort();
			queue = [];
		},
	};
};
