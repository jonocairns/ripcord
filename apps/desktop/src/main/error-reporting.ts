import { homedir } from 'node:os';
import * as Sentry from '@sentry/electron/main';
import type { ErrorEvent } from '@sentry/electron/main';
import { app } from 'electron';
import type { TDesktopErrorReportingConfig } from './types';

let initialized = false;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_PATTERN = /https?:\/\/[^\s)"']+/gi;
const BEARER_PATTERN = /Bearer\s+\S+/gi;

// The OS home directory leaks into nearly every main-process stack frame and
// error message — file:// paths inside the asar, native module paths — and it
// embeds the account name. Collapse it to "~" (both native and forward-slash
// renderings) before anything leaves the process.
const buildHomeDirReplacer = (): ((value: string) => string) => {
	const home = homedir();

	if (!home) {
		return (value) => value;
	}

	const variants = Array.from(new Set([home, home.replace(/\\/g, '/')]));
	const escaped = variants.map((variant) => variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	const pattern = new RegExp(escaped.join('|'), 'gi');

	return (value) => value.replace(pattern, '~');
};

const replaceHomeDir = buildHomeDirReplacer();

const sanitizeString = (value: string): string => {
	return replaceHomeDir(value)
		.replace(URL_PATTERN, '[redacted-url]')
		.replace(BEARER_PATTERN, 'Bearer [redacted]')
		.replace(JWT_PATTERN, '[redacted-token]')
		.replace(EMAIL_PATTERN, '[redacted-email]');
};

// Scrub free-text recursively: Sentry's electron integrations attach IPC payload
// snippets, file-system paths, and process metadata to nested breadcrumb.data and
// extra objects, any of which can embed the home dir, tokens, or emails.
const sanitizeData = (value: unknown): unknown => {
	if (typeof value === 'string') {
		return sanitizeString(value);
	}

	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeData(entry));
	}

	if (value !== null && typeof value === 'object') {
		const sanitized: Record<string, unknown> = {};

		for (const [key, entry] of Object.entries(value)) {
			sanitized[key] = sanitizeData(entry);
		}

		return sanitized;
	}

	return value;
};

const sanitizeExtra = (extra: ErrorEvent['extra']): ErrorEvent['extra'] => {
	if (!extra) {
		return extra;
	}

	return sanitizeData(extra) as ErrorEvent['extra'];
};

// Mirrors the renderer's beforeSend posture (helpers/error-reporting/sanitize.ts):
// strip identifying fields and scrub free-text that could carry secrets or PII.
const sanitizeEvent = (event: ErrorEvent): ErrorEvent => {
	return {
		...event,
		server_name: undefined,
		user: undefined,
		message: event.message ? sanitizeString(event.message) : event.message,
		extra: sanitizeExtra(event.extra),
		breadcrumbs: event.breadcrumbs?.map((breadcrumb) => ({
			...breadcrumb,
			message: breadcrumb.message ? sanitizeString(breadcrumb.message) : breadcrumb.message,
			data: breadcrumb.data ? (sanitizeData(breadcrumb.data) as typeof breadcrumb.data) : breadcrumb.data,
		})),
		exception: event.exception?.values
			? {
					...event.exception,
					values: event.exception.values.map((value) => ({
						...value,
						value: value.value ? sanitizeString(value.value) : value.value,
					})),
				}
			: event.exception,
	};
};

const normalizeSampleRate = (sampleRate: number | undefined): number | undefined => {
	if (sampleRate === undefined || Number.isNaN(sampleRate)) {
		return undefined;
	}

	return Math.min(1, Math.max(0, sampleRate));
};

// Lazily initialize the main-process SDK once the renderer has fetched the
// per-server DSN and forwarded it over IPC. The main process has no DSN of its
// own, so native crashes (incl. GPU) that occur before the user connects to a
// server cannot be captured — only those after this point are. The renderer
// stays on @sentry/react; this is an independent client reporting to the same
// DSN, so we pass getSessions: () => [] to keep the SDK's renderer IPC/protocol
// off our renderer's session.
const configureMainErrorReporting = (config: TDesktopErrorReportingConfig): void => {
	const dsn = config.dsn?.trim();

	if (!dsn || initialized) {
		return;
	}

	const tracesSampleRate = normalizeSampleRate(config.tracingSampleRate);

	Sentry.init({
		dsn,
		release: app.getVersion(),
		environment: app.isPackaged ? 'production' : 'development',
		sendDefaultPii: false,
		ignoreErrors: config.ignoreErrors,
		getSessions: () => [],
		beforeSend: sanitizeEvent,
		...(tracesSampleRate !== undefined && tracesSampleRate > 0 ? { tracesSampleRate } : {}),
		initialScope: {
			tags: {
				runtime: 'desktop-main',
			},
		},
	});

	initialized = true;
};

export { configureMainErrorReporting };
