// Fixed reason codes only: no user/session/provider/error text becomes a label.
type TTelemetryHealthReason =
	| 'diagnostic_stale'
	| 'diagnostic_future'
	| 'diagnostic_queue_full'
	| 'diagnostic_queue_expired'
	| 'diagnostic_log_failure'
	| 'error_adapter_failure'
	| 'error_export_failure'
	| 'error_transport_dropped'
	| 'error_flush_timeout'
	| 'trace_relay_stale'
	| 'trace_relay_future'
	| 'trace_relay_queue_full'
	| 'trace_relay_queue_expired'
	| 'trace_relay_export_failure'
	| 'trace_relay_retry'
	| 'trace_relay_failed_batch'
	| 'trace_relay_shutdown_drop'
	| 'trace_export_failure'
	| 'trace_export_failed_spans'
	| 'trace_shutdown_failure'
	| 'trace_configuration_invalid'
	| 'trace_initialize_failure'
	| 'trace_log_failure';
type TTelemetryHealthSummary = {
	message: 'Telemetry delivery health';
	source: 'telemetry_health';
	kind: 'telemetry_health';
	windowStartedAt: number;
	observedAt: number;
	counters: Partial<Record<TTelemetryHealthReason, number>>;
};

export const createTelemetryHealth = (deps: {
	report: (summary: TTelemetryHealthSummary) => void;
	now?: () => number;
	schedule?: (flush: () => void) => () => void;
}) => {
	const now = deps.now ?? Date.now;
	const schedule =
		deps.schedule ??
		((flush) => {
			const timer = setTimeout(flush, 60_000);
			timer.unref();
			return () => clearTimeout(timer);
		});
	let counters: Partial<Record<TTelemetryHealthReason, number>> = {};
	let windowStartedAt = now();
	let cancel: (() => void) | undefined;
	let closed = false;
	const flush = () => {
		cancel?.();
		cancel = undefined;
		const pending = counters;
		counters = {};
		const observedAt = now();
		const startedAt = windowStartedAt;
		windowStartedAt = observedAt;
		if (Object.keys(pending).length === 0) return;
		try {
			deps.report({
				message: 'Telemetry delivery health',
				source: 'telemetry_health',
				kind: 'telemetry_health',
				windowStartedAt: startedAt,
				observedAt,
				counters: pending,
			});
		} catch {
			// A failing local health sink cannot recurse or affect application work.
		}
	};
	return {
		count: (reason: TTelemetryHealthReason, count = 1) => {
			if (closed || !Number.isFinite(count) || count <= 0) return;
			if (Object.keys(counters).length === 0) windowStartedAt = now();
			counters[reason] = Math.min(0xffff_ffff, (counters[reason] ?? 0) + Math.floor(count));
			try {
				cancel ??= schedule(flush);
			} catch {
				/* Keep counters for shutdown if scheduling fails. */
			}
		},
		close: () => {
			closed = true;
			flush();
		},
	};
};

let reporter: ((summary: TTelemetryHealthSummary) => void) | undefined;
export const setTelemetryHealthReporter = (next: NonNullable<typeof reporter>) => {
	reporter = next;
};
export const telemetryHealth = createTelemetryHealth({ report: (summary) => reporter?.(summary) });
