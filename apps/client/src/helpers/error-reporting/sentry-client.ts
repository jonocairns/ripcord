import { getRuntimeServerConfig } from '@/runtime/server-config';
import { sanitizeContextData, sanitizeSentryEvent, sanitizeString } from './sanitize';

type TSentryBrowserModule = typeof import('@sentry/browser');

type TClientErrorReportingConfig = {
	sentryDsn?: string;
	ignoreErrors?: string[];
};

type TConfiguredClientErrorReportingConfig = {
	sentryDsn: string;
};

type TCaptureSentryErrorOptions = {
	captureSource: string;
	contextName: string;
	context?: unknown;
	error?: unknown;
	message?: string;
};

const capturedErrors = new WeakSet<object>();

let sentryModulePromise: Promise<TSentryBrowserModule | null> | null = null;
let sentrySyncPromise: Promise<void> | null = null;
let clientErrorReportingConfig: TClientErrorReportingConfig = {};
let activeSentryConfig: TConfiguredClientErrorReportingConfig | undefined;

const getRuntimeTag = (): 'desktop' | 'web' => {
	return getRuntimeServerConfig().source === 'desktop' ? 'desktop' : 'web';
};

const getConfiguredSentryConfig = (): TConfiguredClientErrorReportingConfig | undefined => {
	if (!clientErrorReportingConfig.sentryDsn) {
		return undefined;
	}

	return {
		sentryDsn: clientErrorReportingConfig.sentryDsn,
	};
};

const isSentryConfigured = (): boolean => {
	return Boolean(getConfiguredSentryConfig());
};

const loadSentryModule = async (): Promise<TSentryBrowserModule | null> => {
	if (sentryModulePromise) {
		return sentryModulePromise;
	}

	if (!clientErrorReportingConfig.sentryDsn) {
		return null;
	}

	sentryModulePromise = import('@sentry/browser').catch(() => null);

	return sentryModulePromise;
};

const getLoadedSentryModule = async (): Promise<TSentryBrowserModule | null> => {
	return sentryModulePromise ? await sentryModulePromise : null;
};

const syncSentryConfiguration = async (): Promise<void> => {
	if (sentrySyncPromise) {
		return sentrySyncPromise;
	}

	sentrySyncPromise = (async () => {
		const Sentry = await loadSentryModule();
		const configuredSentryConfig = getConfiguredSentryConfig();

		if (!Sentry) {
			return;
		}

		if (configuredSentryConfig) {
			const shouldReinitializeSentry =
				!Sentry.isEnabled() || !activeSentryConfig || activeSentryConfig.sentryDsn !== configuredSentryConfig.sentryDsn;

			if (shouldReinitializeSentry) {
				if (Sentry.isEnabled()) {
					await Sentry.close(2000);
				}

				Sentry.init({
					dsn: configuredSentryConfig.sentryDsn,
					environment: import.meta.env.MODE,
					release: VITE_APP_VERSION,
					sendDefaultPii: false,
					maxBreadcrumbs: 0,
					ignoreErrors: clientErrorReportingConfig.ignoreErrors,
					beforeSend: (event) => sanitizeSentryEvent(event),
					initialScope: {
						tags: {
							runtime: getRuntimeTag(),
						},
					},
				});
				activeSentryConfig = configuredSentryConfig;
			}

			return;
		}

		if (Sentry.isEnabled()) {
			await Sentry.close(2000);
		}

		activeSentryConfig = undefined;
	})().finally(() => {
		sentrySyncPromise = null;
	});

	return sentrySyncPromise;
};

const configureClientErrorReporting = async (config: TClientErrorReportingConfig = {}): Promise<void> => {
	clientErrorReportingConfig = {
		sentryDsn: config.sentryDsn?.trim() || undefined,
		ignoreErrors: config.ignoreErrors,
	};

	await syncSentryConfiguration();
};

const getSentryContext = (value: unknown): Record<string, unknown> | undefined => {
	return sanitizeContextData(value);
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

const captureSentryError = async ({
	captureSource,
	contextName,
	context,
	error,
	message,
}: TCaptureSentryErrorOptions): Promise<void> => {
	if (!isSentryConfigured()) {
		return;
	}

	await syncSentryConfiguration();

	const Sentry = await getLoadedSentryModule();

	if (!Sentry || !Sentry.isEnabled()) {
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
	const sanitizedContext = getSentryContext(context);

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

const reportErrorToSentry = async (message: string, error?: unknown, context?: unknown): Promise<void> => {
	await captureSentryError({
		captureSource: 'reportError',
		contextName: 'reported_error',
		context,
		error,
		message,
	});
};

const reportReactErrorToSentry = async (error: Error, componentStack?: string): Promise<void> => {
	if (!isSentryConfigured()) {
		return;
	}

	await syncSentryConfiguration();

	const Sentry = await getLoadedSentryModule();

	if (!Sentry || !Sentry.isEnabled()) {
		return;
	}

	if (isErrorAlreadyCaptured(error)) {
		return;
	}

	Sentry.withScope((scope) => {
		scope.setTag('capture_source', 'react_error_boundary');
		scope.setTag('runtime', getRuntimeTag());

		Sentry.captureException(error, {
			mechanism: { handled: true, type: 'react' },
			captureContext: componentStack ? { contexts: { react: { componentStack } } } : undefined,
		});
	});
};

export { configureClientErrorReporting, reportErrorToSentry, reportReactErrorToSentry, syncSentryConfiguration };
