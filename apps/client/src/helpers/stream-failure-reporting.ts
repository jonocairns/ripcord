import { StreamKind, type TStreamEventDetails } from '@sharkord/shared';

// Normal reconnects/retries remain logs. Final screen consume exhaustion gets
// a small Sentry budget shared across operations, not one report per retry loop.
export const createStreamFailureReporter = (
	report: (details: TStreamEventDetails) => void,
	now: () => number = Date.now,
) => {
	const cooldowns = new Map<string, number>();
	let reports: number[] = [];
	return (event: TStreamEventDetails) => {
		if (event.event !== 'consume_exhausted' || event.reason !== 'retry_exhausted' || event.kind !== StreamKind.SCREEN)
			return;
		const time = now();
		const key = `${event.remoteId}:${event.kind}:${event.producerId ?? 'unknown'}`;
		reports = reports.filter((timestamp) => time - timestamp < 600_000);
		for (const [entry, timestamp] of cooldowns) if (time - timestamp >= 600_000) cooldowns.delete(entry);
		if (cooldowns.has(key) || reports.length >= 3) return;
		cooldowns.set(key, time);
		reports.push(time);
		try {
			report(event);
		} catch {
			/* Reporting must not affect media. */
		}
	};
};
