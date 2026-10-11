import * as Sentry from '@sentry/react';
import { sdkEventRecord } from '@sharkord/shared';
import { configureClientTracing } from '@/helpers/telemetry/tracing';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { getRuntimeServerConfig } from '@/runtime/server-config';
import { getDiagnosticIdentity, recordDiagnostic } from './delivery';
import { flushErrorReplay } from './replay';
import { sanitizeString } from './sanitize';

type TClientErrorReportingConfig = {
	sentryDsn?: string;
	tracingSentryDsn?: string;
	serverRouted?: boolean;
	ignoreErrors?: string[];
	tracingSampleRate?: number;
	replaySessionSampleRate?: number;
	replayOnErrorSampleRate?: number;
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
let initializedServerUrl: string | undefined;
let scopeIdentity: string | undefined;

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
		if (!frame.filename?.startsWith('file://')) {
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

const buildIntegrations = (
	tracingSampleRate: number | undefined,
	replaySessionSampleRate: number | undefined,
	replayOnErrorSampleRate: number | undefined,
) => {
	const runtimeConfig = getRuntimeServerConfig();
	const integrations = [];

	// Route console.error through Sentry. The vast majority of handled errors in
	// the client are caught and logged with console.error (e.g. the realtime
	// subscription layer) and would otherwise never reach Sentry — the SDK only
	// auto-captures uncaught exceptions, unhandled rejections, and the
	// ErrorBoundary. Captured events still pass through beforeSend (sanitization)
	// and ignoreErrors.
	//
	// dedupeIntegration only collapses a console copy against an explicit capture
	// when both carry the same Error instance. reportError() therefore logs via a
	// pre-init console reference rather than relying on dedupe — see
	// helpers/browser-logger.ts.
	integrations.push(Sentry.captureConsoleIntegration({ levels: ['error'] }));

	if (tracingSampleRate !== undefined && tracingSampleRate > 0) {
		integrations.push(Sentry.browserTracingIntegration());
	}

	// Session Replay. Only attach when a rate is configured so the replay bundle
	// and recording overhead stay out of deployments that haven't opted in. Text
	// and media are always masked — this is a chat app, so replays must never
	// capture message content, usernames, or shared media.
	const replayEnabled =
		(replaySessionSampleRate !== undefined && replaySessionSampleRate > 0) ||
		(replayOnErrorSampleRate !== undefined && replayOnErrorSampleRate > 0);

	if (replayEnabled) {
		integrations.push(Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }));
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
	if (!config.serverRouted && !config.sentryDsn && !config.tracingSentryDsn) return;
	const replayEnabled = (config.replaySessionSampleRate ?? 0) > 0 || (config.replayOnErrorSampleRate ?? 0) > 0;
	const dsn =
		(replayEnabled ? config.sentryDsn?.trim() : undefined) ||
		config.tracingSentryDsn?.trim() ||
		config.sentryDsn?.trim() ||
		'https://ripcord@telemetry.invalid/1';

	if (initialized) {
		if (initializedServerUrl !== getRuntimeServerConfig().serverUrl) {
			configureClientTracing(undefined);
			void Sentry.getReplay?.()?.stop();
		}
		return;
	}
	initializedServerUrl = getRuntimeServerConfig().serverUrl;

	const tracingSampleRate =
		config.tracingSentryDsn?.trim() || config.sentryDsn?.trim() ? normalizeSampleRate(config.tracingSampleRate) : 0;
	const tracingOptions =
		tracingSampleRate !== undefined && tracingSampleRate > 0
			? {
					tracesSampleRate: tracingSampleRate,
					tracePropagationTargets: buildTracePropagationTargets(),
				}
			: {};

	const replaySessionSampleRate = normalizeSampleRate(config.replaySessionSampleRate);
	const replayOnErrorSampleRate = normalizeSampleRate(config.replayOnErrorSampleRate);
	const replayOptions =
		(replaySessionSampleRate !== undefined && replaySessionSampleRate > 0) ||
		(replayOnErrorSampleRate !== undefined && replayOnErrorSampleRate > 0)
			? {
					replaysSessionSampleRate: replaySessionSampleRate ?? 0,
					replaysOnErrorSampleRate: replayOnErrorSampleRate ?? 0,
				}
			: {};

	Sentry.init({
		dsn,
		environment: import.meta.env.MODE,
		release: VITE_APP_VERSION,
		sendDefaultPii: false,
		maxBreadcrumbs: 50,
		ignoreErrors: config.ignoreErrors,
		beforeSendTransaction: (event) => (initializedServerUrl === getRuntimeServerConfig().serverUrl ? event : null),
		beforeSend: (event, hint) => {
			try {
				const identity = getDiagnosticIdentity();
				if (identity && event.tags?.['ripcord.telemetry.identity'] === identity) {
					const record = sdkEventRecord(event, hint, getRuntimeTag());
					const replay = Sentry.getReplay?.();
					const replayId = replay?.getReplayId();
					recordDiagnostic({
						...record,
						context: {
							...Object.fromEntries(Object.entries(record.context ?? {}).slice(0, 19)),
							...(replayId ? { replayId } : {}),
						},
					});
					// Direct error sends are suppressed, so Replay's afterSendEvent hook cannot
					// trigger the buffer. Preserve its opt-in error sampling explicitly.
					if (record.kind === 'exception') flushErrorReplay(replay, replayOnErrorSampleRate ?? 0);
				}
			} catch {
				/* Parsing/reporting is best effort. */
			}
			return null; // JS errors never leave the client through the provider transport.
		},
		integrations: buildIntegrations(tracingSampleRate, replaySessionSampleRate, replayOnErrorSampleRate),
		...tracingOptions,
		...replayOptions,
		initialScope: {
			tags: {
				runtime: getRuntimeTag(),
			},
		},
	});

	if (tracingSampleRate !== undefined && tracingSampleRate > 0) {
		configureClientTracing({
			start: ({ name, attributes }) => {
				const operation = attributes['ripcord.operation'];
				const span = Sentry.startInactiveSpan({
					name,
					op: typeof operation === 'string' ? operation : undefined,
					attributes,
				});
				return {
					run: (effect) => Sentry.withActiveSpan(span, effect),
					setAttributes: (values) => {
						span.setAttributes(values);
					},
					setStatus: (status) => {
						span.setStatus(status);
					},
					end: () => span.end(),
				};
			},
		});
	}

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
	const sanitizedContext =
		context && typeof context === 'object'
			? Object.fromEntries(
					Object.entries(context)
						.slice(0, 20)
						.filter(([_key, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value)),
				)
			: undefined;

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

// Attach (or clear) the authenticated user on the Sentry scope. We send only an
// opaque numeric id — never username/email — to stay consistent with
// sendDefaultPii: false and the sanitization posture. This is what makes issues
// report affected-user counts and ties Session Replays to a specific user.
const setSentryUser = (userId: number | undefined): void => {
	if (!Sentry.isEnabled()) {
		return;
	}

	Sentry.setUser(userId === undefined ? null : { id: String(userId) });
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

const setErrorReportingIdentity = (): void => {
	try {
		const identity = getDiagnosticIdentity();
		if (scopeIdentity && scopeIdentity !== identity) void Sentry.getReplay?.()?.stop();
		scopeIdentity = identity;
		Sentry.setTag('ripcord.telemetry.identity', identity);
		void getDesktopBridge()
			?.configureErrorReporting?.({ routingIdentity: getDiagnosticIdentity() })
			.catch(() => {});
	} catch {
		/* Optional SDK. */
	}
};

export { configureClientErrorReporting, getRuntimeTag, reportErrorToSentry, setErrorReportingIdentity, setSentryUser };
