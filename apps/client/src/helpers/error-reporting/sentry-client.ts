import { CLIENT_ERROR_REPORTING_SENTRY_TUNNEL_PATH } from '@sharkord/shared';
import { getRuntimeServerConfig } from '@/runtime/server-config';
import { isRecord, sanitizeSentryEvent, sanitizeString, sanitizeUnknownValue } from './sanitize';

type TSentryBrowserModule = typeof import('@sentry/browser');

type TClientErrorReportingConfig = {
	sentryDsn?: string;
	sentryTunnelUrl?: string;
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

const getRuntimeTag = (): 'desktop' | 'web' => {
	return getRuntimeServerConfig().source === 'desktop' ? 'desktop' : 'web';
};

const getSentryTunnelUrl = (): string => {
	return `${getRuntimeServerConfig().serverUrl}${CLIENT_ERROR_REPORTING_SENTRY_TUNNEL_PATH}`;
};

const isSentryConfigured = (): boolean => {
	return Boolean(clientErrorReportingConfig.sentryDsn && clientErrorReportingConfig.sentryTunnelUrl);
};

const loadSentryModule = async (): Promise<TSentryBrowserModule | null> => {
	if (!clientErrorReportingConfig.sentryDsn) {
		return null;
	}

	if (!sentryModulePromise) {
		sentryModulePromise = import('@sentry/browser').catch(() => null);
	}

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

		if (!Sentry) {
			return;
		}

		if (isSentryConfigured()) {
			if (!Sentry.isEnabled()) {
				Sentry.init({
					dsn: clientErrorReportingConfig.sentryDsn,
					tunnel: clientErrorReportingConfig.sentryTunnelUrl,
					environment: import.meta.env.MODE,
					release: VITE_APP_VERSION,
					sendDefaultPii: false,
					maxBreadcrumbs: 0,
					beforeSend: (event) => sanitizeSentryEvent(event),
					initialScope: {
						tags: {
							runtime: getRuntimeTag(),
						},
					},
				});
			}

			return;
		}

		if (Sentry.isEnabled()) {
			await Sentry.close(2000);
		}
	})().finally(() => {
		sentrySyncPromise = null;
	});

	return sentrySyncPromise;
};

const configureClientErrorReporting = async (config: TClientErrorReportingConfig): Promise<void> => {
	clientErrorReportingConfig = {
		sentryDsn: config.sentryDsn?.trim() || undefined,
		sentryTunnelUrl: config.sentryTunnelUrl?.trim() || undefined,
	};

	await syncSentryConfiguration();
};

const extractLogMessage = (args: unknown[]): string | undefined => {
	const messageParts = args
		.filter((value): value is string => typeof value === 'string')
		.map((value) => sanitizeString(value))
		.filter((value) => value.length > 0);

	if (messageParts.length === 0) {
		return undefined;
	}

	return messageParts.join(' | ');
};

const getSentryContext = (value: unknown): Record<string, unknown> | undefined => {
	const sanitizedValue = sanitizeUnknownValue(value);

	if (isRecord(sanitizedValue)) {
		return sanitizedValue;
	}

	if (sanitizedValue === undefined) {
		return undefined;
	}

	return { value: sanitizedValue };
};

const markErrorCaptured = (value: unknown): value is Error => {
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

	if (markErrorCaptured(error)) {
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

const captureConsoleError = async (args: unknown[]) => {
	await captureSentryError({
		captureSource: 'console.error',
		contextName: 'console_error',
		context: {
			args: args.map((value) => sanitizeUnknownValue(value)),
			message: extractLogMessage(args),
		},
		error: args.find((value): value is Error => value instanceof Error),
		message: extractLogMessage(args),
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

export {
	captureConsoleError,
	configureClientErrorReporting,
	getSentryTunnelUrl,
	reportErrorToSentry,
	syncSentryConfiguration,
};
