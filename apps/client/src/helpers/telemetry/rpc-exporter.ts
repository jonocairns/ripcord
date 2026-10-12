import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { clientTraceBatchSchema, type TClientTraceBatch } from '@sharkord/shared';
export const createRpcTraceExporter = (
	upload: (batch: TClientTraceBatch, signal: AbortSignal) => Promise<void>,
): SpanExporter & { cancel: () => void } => {
	let enabled = true;
	const active = new Set<AbortController>();
	const cancel = () => {
		enabled = false;
		for (const c of active) c.abort();
		active.clear();
	};
	return {
		cancel,
		shutdown: async () => {
			cancel();
		},
		export: (spans: ReadableSpan[], callback: (result: ExportResult) => void) => {
			if (!enabled || active.size >= 4) {
				callback({ code: ExportResultCode.FAILED });
				return;
			}
			// A user can keep a picker open past the ingestion duration limit. Drop
			// that span alone so it cannot poison unrelated spans in an SDK batch.
			const eligible = spans.filter((span) => {
				const seconds = span.duration[0] + span.duration[1] / 1e9;
				return Number.isFinite(seconds) && seconds >= 0 && seconds <= 600;
			});
			if (eligible.length === 0) {
				callback({ code: ExportResultCode.SUCCESS });
				return;
			}
			const controller = new AbortController();
			active.add(controller);
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const send = async () => {
				const bytes = JsonTraceSerializer.serializeRequest(eligible);
				if (!bytes) throw new Error('Empty trace export');
				const batch = clientTraceBatchSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
				for (let attempt = 0; attempt < 3; attempt++) {
					if (!enabled || controller.signal.aborted) throw new Error('Trace export cancelled');
					const request = new AbortController();
					const onAbort = () => request.abort();
					controller.signal.addEventListener('abort', onAbort, { once: true });
					const requestTimeout = setTimeout(() => request.abort(), 2000);
					try {
						await new Promise<void>((resolve, reject) => {
							const abort = () => reject(new Error('Trace upload cancelled'));
							request.signal.addEventListener('abort', abort, { once: true });
							Promise.resolve()
								.then(() => {
									if (request.signal.aborted) throw new Error('Trace upload cancelled');
									return upload(batch, request.signal);
								})
								.then(resolve, reject)
								.finally(() => request.signal.removeEventListener('abort', abort));
						});
						return;
					} catch (error) {
						if (attempt === 2 || controller.signal.aborted) throw error;
					} finally {
						clearTimeout(requestTimeout);
						controller.signal.removeEventListener('abort', onAbort);
					}
				}
			};
			timeout = setTimeout(() => controller.abort(), 6500);
			void send()
				.then(
					() => callback({ code: ExportResultCode.SUCCESS }),
					() => callback({ code: ExportResultCode.FAILED }),
				)
				.finally(() => {
					clearTimeout(timeout);
					active.delete(controller);
				})
				.catch(() => {});
		},
	};
};
