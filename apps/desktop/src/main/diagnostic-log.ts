import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

type TDiagnosticEvent = {
	event: string;
	level: 'info' | 'warn' | 'error';
	data?: unknown;
	source?: 'main' | 'renderer';
};

const MAX_EVENT_BYTES = 8 * 1024;
const MAX_PENDING_WRITES = 256;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVES = 4;
const SENSITIVE_KEY =
	/token|secret|password|authorization|cookie|dsn|srtp|content|body|username|email|channelName|sourceName|targetName|label/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const validateDiagnosticEvent = (value: unknown): TDiagnosticEvent | undefined => {
	if (!isRecord(value) || typeof value.event !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value.event)) {
		return undefined;
	}
	if (value.level !== 'info' && value.level !== 'warn' && value.level !== 'error') return undefined;
	return { event: value.event, level: value.level, data: value.data };
};

// Keep opaque correlation IDs, but never retain credentials, chat payloads,
// source labels, URLs, home directories or IPv4 addresses in diagnostics.
const sanitizeDiagnosticData = (
	value: unknown,
	homeDirectory: string,
	depth = 0,
	budget = { remaining: 128 },
): unknown => {
	budget.remaining -= 1;
	if (budget.remaining < 0 || depth > 4) return '[truncated]';
	if (typeof value === 'string') {
		let sanitized = value;
		for (const home of new Set([homeDirectory, homeDirectory.replace(/\\/g, '/')])) {
			if (home) sanitized = sanitized.split(home).join('~');
		}
		return sanitized
			.replace(/\b(?:https?|file):\/\/[^\s)"']+/gi, '[redacted-url]')
			.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
			.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
			.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
			.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
			.slice(0, 2048);
	}
	if (value === null || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (value instanceof Error) {
		return sanitizeDiagnosticData({ name: value.name, message: value.message }, homeDirectory, depth + 1, budget);
	}
	if (Array.isArray(value)) {
		return value.slice(0, 20).map((entry) => sanitizeDiagnosticData(entry, homeDirectory, depth + 1, budget));
	}
	if (!isRecord(value)) return undefined;
	const sanitized: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value).slice(0, 32)) {
		if (key.length > 64 || key === '__proto__' || key === 'constructor') continue;
		sanitized[key] = SENSITIVE_KEY.test(key)
			? '[redacted]'
			: sanitizeDiagnosticData(entry, homeDirectory, depth + 1, budget);
	}
	return sanitized;
};

type TDiagnosticLogOptions = {
	directory: string;
	appVersion: string;
	platform: string;
	homeDirectory: string;
	maxFileBytes?: number;
};

const createDiagnosticLog = (options: TDiagnosticLogOptions) => {
	const filePath = path.join(options.directory, 'diagnostics.jsonl');
	const sessionId = randomUUID();
	const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
	let queue = Promise.resolve();
	let pendingWrites = 0;
	let droppedEvents = 0;
	let fileBytes: number | undefined;
	const append = async (line: string): Promise<void> => {
		if (fileBytes === undefined) {
			await mkdir(options.directory, { recursive: true });
			try {
				fileBytes = (await stat(filePath)).size;
			} catch (error) {
				if (!isRecord(error) || error.code !== 'ENOENT') throw error;
				fileBytes = 0;
			}
		}
		const bytes = Buffer.byteLength(line);
		if (fileBytes > 0 && fileBytes + bytes > maxFileBytes) {
			await rm(`${filePath}.${MAX_ARCHIVES}`, { force: true });
			for (let index = MAX_ARCHIVES - 1; index >= 0; index -= 1) {
				try {
					await rename(index === 0 ? filePath : `${filePath}.${index}`, `${filePath}.${index + 1}`);
				} catch (error) {
					if (!isRecord(error) || error.code !== 'ENOENT') throw error;
				}
			}
			fileBytes = 0;
		}
		await appendFile(filePath, line, { mode: 0o600 });
		fileBytes += bytes;
	};
	return {
		write: (event: TDiagnosticEvent): Promise<void> => {
			if (pendingWrites >= MAX_PENDING_WRITES) {
				droppedEvents += 1;
				return Promise.resolve();
			}
			let line: string;
			try {
				const record = {
					timestamp: new Date().toISOString(),
					appVersion: options.appVersion,
					platform: options.platform,
					sessionId,
					event: event.event,
					level: event.level,
					source: event.source ?? 'main',
					droppedEvents,
					data: sanitizeDiagnosticData(event.data, options.homeDirectory),
				};
				line = `${JSON.stringify(record)}\n`;
				if (Buffer.byteLength(line) > MAX_EVENT_BYTES) {
					line = `${JSON.stringify({ ...record, data: { truncated: true } })}\n`;
				}
			} catch {
				droppedEvents += 1;
				return Promise.resolve();
			}
			droppedEvents = 0;
			pendingWrites += 1;
			queue = queue
				.then(() => append(line))
				.catch(() => {
					// Disk failures must never affect capture or recovery. Re-read size on
					// the next write, including after a partially completed rotation.
					fileBytes = undefined;
					droppedEvents += 1;
				})
				.finally(() => {
					pendingWrites -= 1;
				});
			return queue;
		},
		flush: (): Promise<void> => queue,
	};
};

export { createDiagnosticLog, sanitizeDiagnosticData, validateDiagnosticEvent };
