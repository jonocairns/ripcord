import { getDesktopBridge } from '@/runtime/desktop-bridge';

// Errors lose their useful fields when cloned over Electron IPC. Bound the
// traversal before sending; the main-process sink sanitizes again before disk.
const serializeDiagnosticData = (value: unknown, depth = 0, budget = { remaining: 128 }): unknown => {
	budget.remaining -= 1;
	if (budget.remaining < 0 || depth > 4) return '[truncated]';
	if (value instanceof Error) return { name: value.name, message: value.message.slice(0, 2048) };
	if (Array.isArray(value)) return value.slice(0, 20).map((entry) => serializeDiagnosticData(entry, depth + 1, budget));
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.slice(0, 32)
				.map(([key, entry]) => [key, serializeDiagnosticData(entry, depth + 1, budget)]),
		);
	}
	if (typeof value === 'string') return value.slice(0, 2048);
	if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
	return undefined;
};

let pendingWrites = 0;
const recordDesktopDiagnostic = (event: string, data?: unknown, level: 'info' | 'warn' | 'error' = 'info'): void => {
	let accepted = false;
	try {
		const write = getDesktopBridge()?.writeDiagnosticEvent;
		if (!write || pendingWrites >= 128) return;
		const dataToWrite = serializeDiagnosticData(data);
		pendingWrites += 1;
		accepted = true;
		void write({ event, level, data: dataToWrite })
			.catch(() => {})
			.finally(() => {
				pendingWrites -= 1;
			});
	} catch {
		if (accepted) pendingWrites -= 1;
		// Older desktop builds, closed renderers and IPC failures must not alter
		// media behavior or create recursive error-reporting failures.
	}
};

export { recordDesktopDiagnostic, serializeDiagnosticData };
