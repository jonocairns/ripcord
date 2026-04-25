import * as Sentry from '@sentry/react';
import { getRuntimeServerConfig } from '@/runtime/server-config';
import { sanitizeContextData, sanitizeSentryEvent, sanitizeString } from './sanitize';

type TClientErrorReportingConfig = {
	sentryDsn?: string;
	ignoreErrors?: string[];
};

type TCaptureSentryErrorOptions = {
	captureSource: string;
	contextName: string;
	context?: unknown;
	error?: unknown;
	message?: string;
};

const capturedErrors = new WeakSet<object>();

let initialized = false;

const getRuntimeTag = (): 'desktop' | 'web' => {
	return getRuntimeServerConfig().source === 'desktop' ? 'desktop' : 'web';
};

const configureClientErrorReporting = (config: TClientErrorReportingConfig = {}): void => {
	const dsn = config.sentryDsn?.trim();

	if (!dsn || initialized) {
		return;
	}

	Sentry.init({
		dsn,
		environment: import.meta.env.MODE,
		release: VITE_APP_VERSION,
		sendDefaultPii: false,
		maxBreadcrumbs: 0,
		ignoreErrors: config.ignoreErrors,
		beforeSend: (event) => sanitizeSentryEvent(event),
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

export { configureClientErrorReporting, getRuntimeTag, reportErrorToSentry };
