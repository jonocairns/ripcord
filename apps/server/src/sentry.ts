// The server runs on Bun (compiled single-file binary in production), so use
// the first-class @sentry/bun SDK rather than @sentry/node. It re-exports the
// Node API — captureException, captureMessage, close, etc. all behave the same
// — but is built for the Bun runtime. Note: Sentry auto-instrumentation (and
// thus tracesSampleRate) does not attach inside a compiled single-file
// executable; error capture, which is what we rely on, is unaffected.

import type { ErrorEvent } from '@sentry/bun';
import * as Sentry from '@sentry/bun';
import { format } from 'winston';
import { config } from './config';
import { IS_PRODUCTION, SERVER_VERSION } from './utils/env';

const SPLAT = Symbol.for('splat');
// Winston's canonical, immutable level. We must read this rather than
// `info.level`, because `colorize()` runs earlier in the format chain and
// rewrites `info.level` to an ANSI-wrapped string (e.g. "\x1b[31merror\x1b[39m")
// that never equals "error" — which would silently skip every Sentry capture.
const LEVEL = Symbol.for('level');

// Scrub credentials and PII before any event leaves the process. The server now
// forwards winston error messages and stack traces to Sentry (see sentryFormat),
// any of which can embed auth tokens (JWTs), Authorization headers, or emails.
// Unlike the desktop scrubber we deliberately leave URLs intact — request
// paths/hosts are valuable for server debugging and are not themselves secret;
// JWT/Bearer scrubbing still removes credentials carried inside a URL.
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_PATTERN = /Bearer\s+\S+/gi;

const sanitizeString = (value: string): string =>
	value
		.replace(BEARER_PATTERN, 'Bearer [redacted]')
		.replace(JWT_PATTERN, '[redacted-token]')
		.replace(EMAIL_PATTERN, '[redacted-email]');

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

const sanitizeServerEvent = (event: ErrorEvent): ErrorEvent => ({
	...event,
	message: event.message ? sanitizeString(event.message) : event.message,
	extra: event.extra ? (sanitizeData(event.extra) as ErrorEvent['extra']) : event.extra,
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
});

// Flush buffered events before the process exits. Safe to call when Sentry was
// never initialised (no DSN) — close() resolves immediately. The graceful-
// shutdown orchestrator owns the termination signals and sequences this flush
// just before the final process exit, so events captured moments before
// shutdown aren't lost.
const flushSentry = async (): Promise<void> => {
	try {
		await Sentry.close(2000);
	} catch {
		// Flush failed (network/SDK error) — never block shutdown on telemetry.
	}
};

const initSentry = (): void => {
	const dsn = config.server.serverErrorReportingSentryDsn.trim();

	if (!dsn) {
		return;
	}

	const serverTracingSampleRate = config.server.serverTracingSampleRate;
	const tracingOptions = serverTracingSampleRate > 0 ? { tracesSampleRate: serverTracingSampleRate } : {};

	Sentry.init({
		dsn,
		environment: IS_PRODUCTION ? 'production' : 'development',
		release: SERVER_VERSION,
		sendDefaultPii: false,
		beforeSend: sanitizeServerEvent,
		...tracingOptions,
	});
};

const sentryFormat = format((info) => {
	if ((info as Record<symbol, unknown>)[LEVEL] !== 'error') {
		return info;
	}

	const splat = (info as Record<symbol, unknown[]>)[SPLAT] ?? [];
	const errorFromSplat = splat.find((arg): arg is Error => arg instanceof Error);
	const additionalSplat = splat.filter((arg) => arg !== errorFromSplat);

	const extra: Record<string, unknown> = {
		message: String(info.message),
	};

	if (additionalSplat.length > 0) {
		extra.splat = additionalSplat;
	}

	if (errorFromSplat) {
		Sentry.captureException(errorFromSplat, { extra });
	} else if (info instanceof Error) {
		Sentry.captureException(info, { extra });
	} else {
		Sentry.captureMessage(String(info.message), {
			level: 'error',
			extra,
		});
	}

	return info;
});

export { flushSentry, initSentry, Sentry, sentryFormat };
