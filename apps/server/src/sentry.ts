// The server runs on Bun (compiled single-file binary in production), so use
// the first-class @sentry/bun SDK rather than @sentry/node. It re-exports the
// Node API — captureException, captureMessage, close, etc. all behave the same
// — but is built for the Bun runtime. Note: Sentry auto-instrumentation (and
// automatic spans) does not attach inside a compiled single-file executable.
// Manual OpenTelemetry spans still use its provider, async context and sampler.

import type { ErrorEvent } from '@sentry/bun';
import * as Sentry from '@sentry/bun';
import { format } from 'winston';
import { config } from './config';
import { configureServerTracing } from './helpers/tracing';
import { IS_PRODUCTION, SERVER_VERSION } from './utils/env';

let errorClient: Sentry.BunClient | undefined;
const getErrorClient = () => {
	const dsn = config.server.serverErrorReportingSentryDsn.trim();
	if (!dsn) return undefined;
	errorClient ??= new Sentry.BunClient({
		dsn,
		transport: Sentry.makeFetchTransport,
		stackParser: Sentry.defaultStackParser,
		integrations: [],
		release: SERVER_VERSION,
		environment: IS_PRODUCTION ? 'production' : 'development',
		sendDefaultPii: false,
		beforeSend: sanitizeServerEvent,
	});
	return errorClient;
};
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

// `seen` tracks objects already on the current walk so a cyclic request/socket/
// plugin object in the splat args can't drive infinite recursion. Without it a
// cycle throws a RangeError inside beforeSend, and Sentry silently drops the
// very error event we were trying to capture.
const sanitizeData = (value: unknown, seen: WeakSet<object> = new WeakSet()): unknown => {
	if (typeof value === 'string') {
		return sanitizeString(value);
	}

	if (value !== null && typeof value === 'object') {
		if (seen.has(value)) {
			return '[circular]';
		}

		seen.add(value);

		if (Array.isArray(value)) {
			return value.map((entry) => sanitizeData(entry, seen));
		}

		const sanitized: Record<string, unknown> = {};

		for (const [key, entry] of Object.entries(value)) {
			sanitized[key] = sanitizeData(entry, seen);
		}

		return sanitized;
	}

	return value;
};

const sanitizeServerEvent = (event: ErrorEvent): ErrorEvent => ({
	...event,
	message: event.message ? sanitizeString(event.message) : event.message,
	extra: event.extra ? (sanitizeData(event.extra) as ErrorEvent['extra']) : event.extra,
	// request/contexts/user/stack-frame vars are normally absent in the compiled
	// Bun binary (auto-instrumentation doesn't attach, sendDefaultPii is false),
	// but a direct captureException or a dev run can still populate them — scrub
	// them too so an Authorization header, JWT, or email can never slip through.
	request: event.request ? (sanitizeData(event.request) as ErrorEvent['request']) : event.request,
	contexts: event.contexts ? (sanitizeData(event.contexts) as ErrorEvent['contexts']) : event.contexts,
	user: event.user ? (sanitizeData(event.user) as ErrorEvent['user']) : event.user,
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
					stacktrace: value.stacktrace
						? {
								...value.stacktrace,
								frames: value.stacktrace.frames?.map((frame) => ({
									...frame,
									vars: frame.vars ? (sanitizeData(frame.vars) as typeof frame.vars) : frame.vars,
								})),
							}
						: value.stacktrace,
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
		await Promise.allSettled([Sentry.close(2000), errorClient?.close(2000)]);
	} catch {
		// Flush failed (network/SDK error) — never block shutdown on telemetry.
	}
};

const initSentry = (): void => {
	const dsn = config.server.serverTracingSentryDsn.trim() || config.server.serverErrorReportingSentryDsn.trim();

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
		beforeSend: (event) => {
			try {
				getErrorClient()?.captureEvent(sanitizeServerEvent(event));
			} catch {
				/* Error adapter isolated. */
			}
			return null;
		},
		...tracingOptions,
	});
	configureServerTracing(serverTracingSampleRate > 0);
};

const sentryFormat = format((info) => {
	if (!config.server.serverErrorReportingSentryDsn.trim() || (info as Record<symbol, unknown>)[LEVEL] !== 'error') {
		return info;
	}

	const splat = (info as Record<symbol, unknown[]>)[SPLAT] ?? [];
	const errorFromSplat =
		info.originalError instanceof Error ? info.originalError : splat.find((arg): arg is Error => arg instanceof Error);
	const additionalSplat = splat.filter((arg) => arg !== errorFromSplat);

	const extra: Record<string, unknown> = {
		message: String(info.message),
	};

	if (additionalSplat.length > 0) {
		extra.splat = additionalSplat;
	}

	try {
		const scope = new Sentry.Scope();
		scope.setExtras(extra);
		if (errorFromSplat) {
			getErrorClient()?.captureException(errorFromSplat, undefined, scope);
		} else if (info instanceof Error) {
			getErrorClient()?.captureException(info, undefined, scope);
		} else {
			getErrorClient()?.captureMessage(String(info.message), 'error', undefined, scope);
		}
	} catch {
		/* Adapter errors must not break Winston or recurse. */
	}
	return info;
});

export { flushSentry, initSentry, sentryFormat };
