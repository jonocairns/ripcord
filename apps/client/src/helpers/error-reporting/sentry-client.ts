import * as Sentry from '@sentry/react';
import { getRuntimeServerConfig } from '@/runtime/server-config';
import { sanitizeContextData, sanitizeSentryEvent, sanitizeString } from './sanitize';

type TClientErrorReportingConfig = {
	sentryDsn?: string;
	ignoreErrors?: string[];
	tracingSampleRate?: number;
};

type TCaptureSentryErrorOptions = {
	captureSource: string;
	contextName: string;
	context?: unknown;
	error?: unknown;
	message?: string;
};

type TSentrySpanOptions = {
	name: string;
	op?: string;
	attributes?: Record<string, string | number | boolean | undefined>;
};

const capturedErrors = new WeakSet<object>();

let initialized = false;

const getRuntimeTag = (): 'desktop' | 'web' => {
	return getRuntimeServerConfig().source === 'desktop' ? 'desktop' : 'web';
};

// Desktop renderer assets load from `file://` inside the Electron asar, so
// Sentry cannot fetch the source maps from the local path in stack frames.
// Rewrite each `file:///.../assets/<chunk>.js` frame to the same chunk on the
// chat server's public URL — Sentry then fetches the JS + .map from there
// (Pattern A). Works as long as the desktop bundle hash matches the server's
// (i.e. desktop and server were built from the same client commit); on a
// version mismatch frames stay as `file://` and Sentry can't symbolicate,
// which is the same behavior as before this rewrite existed.
const buildDesktopFrameRewriter = (serverUrl: string) => {
	const baseUrl = serverUrl.replace(/\/+$/, '');
	const assetPattern = /\/assets\/([^/?#]+\.js)(?:[?#].*)?$/;

	return (frame: { filename?: string }) => {
		if (!frame.filename || !frame.filename.startsWith('file://')) {
			return frame;
		}

		const match = frame.filename.match(assetPattern);

		if (!match) {
			return frame;
		}

		return {
			...frame,
			filename: `${baseUrl}/assets/${match[1]}`,
		};
	};
};

const normalizeSampleRate = (sampleRate: number | undefined): number | undefined => {
	if (sampleRate === undefined || Number.isNaN(sampleRate)) {
		return undefined;
	}

	return Math.min(1, Math.max(0, sampleRate));
};

const buildTracePropagationTargets = (): string[] | undefined => {
	const runtimeConfig = getRuntimeServerConfig();

	if (!runtimeConfig.serverUrl) {
		return undefined;
	}

	return [runtimeConfig.serverUrl];
};

const buildIntegrations = (tracingSampleRate: number | undefined) => {
	const runtimeConfig = getRuntimeServerConfig();
	const integrations = [];

	if (tracingSampleRate !== undefined && tracingSampleRate > 0) {
		integrations.push(Sentry.browserTracingIntegration());
	}

	if (runtimeConfig.source === 'desktop' && runtimeConfig.serverUrl) {
		integrations.push(
			Sentry.rewriteFramesIntegration({
				iteratee: buildDesktopFrameRewriter(runtimeConfig.serverUrl),
			}),
		);
	}

	return integrations.length > 0 ? integrations : undefined;
};

const configureClientErrorReporting = (config: TClientErrorReportingConfig = {}): void => {
	const dsn = config.sentryDsn?.trim();

	if (!dsn || initialized) {
		return;
	}

	const tracingSampleRate = normalizeSampleRate(config.tracingSampleRate);
	const tracingOptions =
		tracingSampleRate !== undefined && tracingSampleRate > 0
			? {
					tracesSampleRate: tracingSampleRate,
					tracePropagationTargets: buildTracePropagationTargets(),
				}
			: {};

	Sentry.init({
		dsn,
		environment: import.meta.env.MODE,
		release: VITE_APP_VERSION,
		sendDefaultPii: false,
		maxBreadcrumbs: 0,
		ignoreErrors: config.ignoreErrors,
		beforeSend: (event) => sanitizeSentryEvent(event),
		integrations: buildIntegrations(tracingSampleRate),
		...tracingOptions,
		initialScope: {
			tags: {
				runtime: getRuntimeTag(),
			},
		},
	});

	initialized = true;
};

const isErrorAlreadyCaptured = (value: unknown): value is Error => {
	if (!(value instanceof Error)) {
		return false;
	}

	if (capturedErrors.has(value)) {
		return true;
	}

	capturedErrors.add(value);
	return false;
};

const captureSentryError = ({
	captureSource,
	contextName,
	context,
	error,
	message,
}: TCaptureSentryErrorOptions): void => {
	if (!Sentry.isEnabled()) {
		return;
	}

	if (isErrorAlreadyCaptured(error)) {
		return;
	}

	const fallbackMessage =
		message ??
		(typeof error === 'string'
			? sanitizeString(error)
			: error instanceof Error
				? sanitizeString(error.message)
				: undefined);
	const sanitizedContext = sanitizeContextData(context);

	Sentry.withScope((scope) => {
		scope.setTag('capture_source', captureSource);
		scope.setTag('runtime', getRuntimeTag());

		if (sanitizedContext) {
			scope.setContext(contextName, sanitizedContext);
		}

		if (error instanceof Error) {
			Sentry.captureException(error);
			return;
		}

		Sentry.captureException(new Error(fallbackMessage ?? 'Reported error'));
	});
};

const reportErrorToSentry = (message: string, error?: unknown, context?: unknown): void => {
	captureSentryError({
		captureSource: 'reportError',
		contextName: 'reported_error',
		context,
		error,
		message,
	});
};

const traceSentrySpan = <T>({ name, op, attributes }: TSentrySpanOptions, callback: () => T): T => {
	if (!Sentry.isEnabled()) {
		return callback();
	}

	return Sentry.startSpan(
		{
			name,
			op,
			attributes,
		},
		() => callback(),
	);
};

export { configureClientErrorReporting, getRuntimeTag, reportErrorToSentry, traceSentrySpan };
