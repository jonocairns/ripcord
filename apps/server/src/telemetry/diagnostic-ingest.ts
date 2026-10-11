import { sanitizeDiagnosticRecord, type TDiagnosticBatch, type TDiagnosticRecord } from '@sharkord/shared';
import type { telemetryHealth } from './health';

type TAccepted = {
	record: TDiagnosticRecord;
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
			for (const record of batch.records) {
				if (receivedAt - record.occurredAt > 300_000) {
					count('diagnostic_stale');
					continue;
				}
				if (record.occurredAt - receivedAt > 60_000) {
					count('diagnostic_future');
					continue;
				}
				if (queue.length >= 256) {
					count('diagnostic_queue_full');
					continue;
				}
				const key = `${userId}:${batch.clientSessionId}:${record.id}`;
				if (seen.has(key)) continue;
				// Keep the cache bounded without blocking every user's fresh reports.
				if (seen.size >= 4096) {
					const oldest = seen.keys().next().value;
					if (oldest !== undefined) seen.delete(oldest);
				}
				seen.set(key, receivedAt + 300_000);
				queue.push({
					record: sanitizeDiagnosticRecord(record),
					reporterUserId: userId,
					clientSessionId: batch.clientSessionId,
					droppedEvents: batch.droppedEvents,
					receivedAt,
				});
			}
			timer ??= setTimeout(drain, 0);
		},
		flush: drain,
	};
};
