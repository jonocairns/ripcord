import { sanitizeDiagnosticRecord, type TDiagnosticBatch, type TDiagnosticRecord } from '@sharkord/shared';
import type { telemetryHealth } from './health';

type TAccepted = {
	record: TDiagnosticRecord & {
		originalOccurredAt?: number;
		clockSkewMs?: number;
		clockSkewCorrected?: boolean;
	};
	reporterUserId: number;
	clientSessionId: string;
	droppedEvents: number;
	receivedAt: number;
};
export const createDiagnosticIngest = (deps: {
	log: (accepted: TAccepted) => void;
	forward: (record: TDiagnosticRecord, userId: number, sessionId: string) => void;
	now?: () => number;
	health?: Pick<typeof telemetryHealth, 'count'>;
}) => {
	const now = deps.now ?? Date.now;
	const count: NonNullable<typeof deps.health>['count'] = (reason) => {
		try {
			deps.health?.count(reason);
		} catch {
			/* Health is optional. */
		}
	};
	let queue: TAccepted[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	const seen = new Map<string, number>();
	const drain = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		const pending = queue;
		queue = [];
		for (const entry of pending) {
			if (now() - entry.receivedAt > 30_000) {
				count('diagnostic_queue_expired');
				continue;
			}
			try {
				deps.log(entry);
			} catch {
				count('diagnostic_log_failure');
			}
			try {
				deps.forward(entry.record, entry.reporterUserId, entry.clientSessionId);
			} catch {
				count('error_adapter_failure');
			}
		}
	};
	return {
		accept: (batch: TDiagnosticBatch, userId: number) => {
			const receivedAt = now();
			for (const [key, expiresAt] of seen) if (expiresAt <= receivedAt) seen.delete(key);
			// Shift the entire batch together so relative event and breadcrumb times survive.
			const offset = Math.max(...batch.records.map((record) => record.occurredAt)) - receivedAt;
			const batchSkewMs = offset > 60_000 ? offset : 0;
			let queuedCorrected = false;
			for (const record of batch.records) {
				const key = `${userId}:${batch.clientSessionId}:${record.id}`;
				if (seen.has(key)) continue;
				// A record whose own stamp is already in the accepted window keeps it when the batch
				// offset would push it past the stale cutoff: the client clock may have been fixed
				// mid-batch, or one record carried a bogus future stamp.
				const rawInWindow = receivedAt - record.occurredAt <= 300_000 && record.occurredAt - receivedAt <= 60_000;
				const clockSkewMs =
					batchSkewMs && rawInWindow && receivedAt - (record.occurredAt - batchSkewMs) > 300_000 ? 0 : batchSkewMs;
				if (receivedAt - (record.occurredAt - clockSkewMs) > 300_000) {
					count('diagnostic_stale');
					continue;
				}
				if (queue.length >= 256) {
					count('diagnostic_queue_full');
					continue;
				}
				// Keep the cache bounded without blocking every user's fresh reports.
				if (seen.size >= 4096) {
					const oldest = seen.keys().next().value;
					if (oldest !== undefined) seen.delete(oldest);
				}
				seen.set(key, receivedAt + 300_000);
				if (clockSkewMs) queuedCorrected = true;
				const sanitized = sanitizeDiagnosticRecord(record);
				queue.push({
					record: {
						...sanitized,
						...(clockSkewMs
							? {
									occurredAt: record.occurredAt - clockSkewMs,
									originalOccurredAt: record.occurredAt,
									clockSkewMs,
									clockSkewCorrected: true,
									breadcrumbs: sanitized.breadcrumbs?.flatMap((breadcrumb) => {
										const occurredAt = breadcrumb.occurredAt - clockSkewMs;
										return Number.isFinite(occurredAt) && occurredAt >= 0 && occurredAt <= 8_640_000_000_000_000
											? [{ ...breadcrumb, occurredAt }]
											: [];
									}),
								}
							: {}),
					},
					reporterUserId: userId,
					clientSessionId: batch.clientSessionId,
					droppedEvents: batch.droppedEvents,
					receivedAt,
				});
			}
			if (queuedCorrected) count('diagnostic_clock_skew_corrected_batches');
			timer ??= setTimeout(drain, 0);
		},
		flush: drain,
	};
};
