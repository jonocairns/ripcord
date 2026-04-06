import type { ErrorEvent, Event } from '@sentry/browser';

type TSanitizedContextPrimitive = string | number | boolean | null;
type TSanitizedContextValue = TSanitizedContextPrimitive | Array<TSanitizedContextPrimitive>;
type TSanitizedContextData = Record<string, TSanitizedContextValue>;

const MAX_CONTEXT_KEYS = 10;
const MAX_CONTEXT_ARRAY_ITEMS = 10;
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

	return tokens.length === 1 && tokens[0] === 'ip';
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

const sanitizeContextPrimitive = (value: unknown, parentKey?: string): TSanitizedContextPrimitive | undefined => {
	if (isSensitiveKey(parentKey)) {
		return '[redacted]';
	}

	if (typeof value === 'string') {
		return sanitizeString(value);
	}

	if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
		return value;
	}

	return undefined;
};

const sanitizeContextValue = (value: unknown, parentKey?: string): TSanitizedContextValue | undefined => {
	const primitiveValue = sanitizeContextPrimitive(value, parentKey);

	if (primitiveValue !== undefined) {
		return primitiveValue;
	}

	if (!Array.isArray(value)) {
		return undefined;
	}

	const sanitizedEntries = value
		.slice(0, MAX_CONTEXT_ARRAY_ITEMS)
		.map((entry) => sanitizeContextPrimitive(entry, parentKey))
		.filter((entry): entry is TSanitizedContextPrimitive => entry !== undefined);

	return sanitizedEntries.length > 0 ? sanitizedEntries : undefined;
};

const sanitizeContextData = (value: unknown): TSanitizedContextData | undefined => {
	if (!isRecord(value)) {
		return undefined;
	}

	const sanitizedEntries = Object.entries(value)
		.slice(0, MAX_CONTEXT_KEYS)
		.flatMap(([key, entry]) => {
			const sanitizedValue = sanitizeContextValue(entry, key);

			return sanitizedValue === undefined ? [] : [[key, sanitizedValue] as const];
		});

	return sanitizedEntries.length > 0 ? Object.fromEntries(sanitizedEntries) : undefined;
};

const sanitizeExtras = (value: Event['extra']): NonNullable<Event['extra']> | undefined => {
	return sanitizeContextData(value);
};

const sanitizeContexts = (value: Event['contexts']): NonNullable<Event['contexts']> | undefined => {
	if (!isRecord(value)) {
		return undefined;
	}

	const sanitized: NonNullable<Event['contexts']> = {};

	for (const [key, entry] of Object.entries(value)) {
		const sanitizedEntry = sanitizeContextData(entry);

		if (sanitizedEntry) {
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

export { sanitizeContextData, sanitizeSentryEvent, sanitizeString };
