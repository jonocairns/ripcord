import { sanitizeDiagnosticRecord, type TDiagnosticBatch, type TDiagnosticRecord } from '@sharkord/shared';

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
}) => {
	const now = deps.now ?? Date.now;
	let queue: TAccepted[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	const seen = new Map<string, number>();
	const drain = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		const pending = queue;
		queue = [];
		for (const entry of pending) {
			if (now() - entry.receivedAt > 30_000) continue;
			try {
				deps.log(entry);
			} catch {
				/* No recursive reporting. */
			}
			try {
				deps.forward(entry.record, entry.reporterUserId, entry.clientSessionId);
			} catch {
				/* Adapter isolated. */
			}
		}
	};
	return {
		accept: (batch: TDiagnosticBatch, userId: number) => {
			const receivedAt = now();
			for (const [key, expiresAt] of seen) if (expiresAt <= receivedAt) seen.delete(key);
			for (const record of batch.records) {
				if (receivedAt - record.occurredAt > 300_000 || record.occurredAt - receivedAt > 60_000 || queue.length >= 256)
					continue;
				const key = `${userId}:${batch.clientSessionId}:${record.id}`;
				if (seen.has(key)) continue;
				// Keep dedupe bounded; new records are shed rather than evicting retry evidence.
				if (seen.size >= 4096) continue;
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
