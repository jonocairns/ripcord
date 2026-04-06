import type { ErrorEvent, Event } from '@sentry/browser';

const MAX_SANITIZE_DEPTH = 4;
const MAX_ARRAY_SANITIZE_ITEMS = 20;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const LONG_NUMERIC_SEGMENT_PATTERN = /\b\d{6,}\b/g;
const URL_PATTERN = /https?:\/\/[^\s)"']+/gi;
const STRONGLY_SENSITIVE_KEY_TOKENS = new Set([
	'authorization',
	'cookie',
	'token',
	'secret',
	'password',
	'passwd',
	'refresh',
	'session',
	'dsn',
]);
const ENDING_SENSITIVE_KEY_FRAGMENTS = ['email', 'username', 'identity', 'bio', 'content', 'message', 'ipaddress'];

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null;
};

const splitKeyTokens = (key: string): string[] => {
	return key
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+|\s+/)
		.map((token) => token.toLowerCase())
		.filter((token) => token.length > 0);
};

const isSensitiveKey = (key?: string): boolean => {
	if (!key) {
		return false;
	}

	const tokens = splitKeyTokens(key);

	if (tokens.some((token) => STRONGLY_SENSITIVE_KEY_TOKENS.has(token))) {
		return true;
	}

	const normalizedKey = tokens.join('');

	if (normalizedKey === 'ip') {
		return true;
	}

	return ENDING_SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalizedKey.endsWith(fragment));
};

const sanitizeUrl = (value: string): string => {
	try {
		const url = new URL(value);
		const sanitizedPathname = url.pathname
			.replace(UUID_PATTERN, '[uuid]')
			.replace(LONG_NUMERIC_SEGMENT_PATTERN, '[id]');

		return `${url.origin}${sanitizedPathname}`;
	} catch {
		return value
			.replace(URL_PATTERN, '[redacted-url]')
			.replace(UUID_PATTERN, '[uuid]')
			.replace(LONG_NUMERIC_SEGMENT_PATTERN, '[id]');
	}
};

const sanitizeString = (value: string): string => {
	return value
		.replace(URL_PATTERN, (match) => sanitizeUrl(match))
		.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
		.replace(JWT_PATTERN, '[redacted-token]')
		.replace(EMAIL_PATTERN, '[redacted-email]')
		.replace(UUID_PATTERN, '[uuid]')
		.replace(LONG_NUMERIC_SEGMENT_PATTERN, '[id]');
};

const sanitizeUnknownValue = (value: unknown, parentKey?: string, depth = 0): unknown => {
	if (isSensitiveKey(parentKey)) {
		return '[redacted]';
	}

	if (depth >= MAX_SANITIZE_DEPTH) {
		return '[truncated]';
	}

	if (typeof value === 'string') {
		return sanitizeString(value);
	}

	if (Array.isArray(value)) {
		return value.slice(0, MAX_ARRAY_SANITIZE_ITEMS).map((entry) => sanitizeUnknownValue(entry, parentKey, depth + 1));
	}

	if (isRecord(value)) {
		const sanitized: Record<string, unknown> = {};

		for (const [key, entry] of Object.entries(value)) {
			sanitized[key] = sanitizeUnknownValue(entry, key, depth + 1);
		}

		return sanitized;
	}

	return value;
};

const sanitizeExtras = (value: Event['extra']): NonNullable<Event['extra']> | undefined => {
	if (!isRecord(value)) {
		return undefined;
	}

	const sanitized: NonNullable<Event['extra']> = {};

	for (const [key, entry] of Object.entries(value)) {
		sanitized[key] = sanitizeUnknownValue(entry, key, 1);
	}

	return sanitized;
};

const sanitizeContexts = (value: Event['contexts']): NonNullable<Event['contexts']> | undefined => {
	if (!isRecord(value)) {
		return undefined;
	}

	const sanitized: NonNullable<Event['contexts']> = {};

	for (const [key, entry] of Object.entries(value)) {
		const sanitizedEntry = sanitizeUnknownValue(entry, key, 1);

		if (isRecord(sanitizedEntry)) {
			sanitized[key] = sanitizedEntry;
		}
	}

	return sanitized;
};

function sanitizeSentryEvent(event: ErrorEvent): ErrorEvent;
function sanitizeSentryEvent(event: Event): Event;
function sanitizeSentryEvent(event: Event): Event {
	return {
		...event,
		message: event.message ? sanitizeString(event.message) : event.message,
		server_name: undefined,
		user: undefined,
		request: event.request
			? {
					...event.request,
					url: event.request.url ? sanitizeUrl(event.request.url) : event.request.url,
					headers: undefined,
					cookies: undefined,
					data: undefined,
					query_string: undefined,
				}
			: event.request,
		breadcrumbs: undefined,
		extra: sanitizeExtras(event.extra),
		contexts: sanitizeContexts(event.contexts),
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
}

export { isRecord, sanitizeSentryEvent, sanitizeString, sanitizeUnknownValue };
