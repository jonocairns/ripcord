import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

const serverConfig = await import('@/runtime/server-config');
let restoreRuntimeConfig: (() => void) | undefined;

afterEach(() => {
	restoreRuntimeConfig?.();
	restoreRuntimeConfig = undefined;
});

describe('configureClientErrorReporting', () => {
	test('error SDK configuration cannot initialize tracing or redirect replay to a trace DSN', async () => {
		const initMock = mock((_options: unknown) => undefined);
		const browserTracingIntegrationMock = mock((_options: unknown) => ({
			name: 'browserTracingIntegration',
		}));
		const captureConsoleIntegrationMock = mock((_options: unknown) => ({
			name: 'captureConsoleIntegration',
		}));
		let sentryEnabled = false;
		const spanEndMock = mock(() => undefined);
		const spanSetAttributesMock = mock((_attributes: unknown) => undefined);
		const spanSetStatusMock = mock((_status: unknown) => undefined);
		const startInactiveSpanMock = mock((_options: unknown) => ({
			end: spanEndMock,
			setAttributes: spanSetAttributesMock,
			setStatus: spanSetStatusMock,
		}));

		mock.module('@sentry/react', () => ({
			init: (options: unknown) => {
				sentryEnabled = true;
				initMock(options);
			},
			isEnabled: () => sentryEnabled,
			browserTracingIntegration: browserTracingIntegrationMock,
			captureConsoleIntegration: captureConsoleIntegrationMock,
			startSpan: (_options: unknown, callback: () => unknown) => callback(),
			startInactiveSpan: startInactiveSpanMock,
			withActiveSpan: (_span: unknown, callback: () => unknown) => callback(),
			withScope: mock(() => undefined),
			captureException: mock(() => undefined),
			ErrorBoundary: () => null,
		}));
		const configSpy = spyOn(serverConfig, 'getRuntimeServerConfig').mockReturnValue({
			source: 'web',
			serverUrl: 'https://server.example',
			serverHost: 'server.example',
			isConfigured: true,
			needsSetup: false,
		});
		restoreRuntimeConfig = () => configSpy.mockRestore();

		Reflect.set(globalThis, 'VITE_APP_VERSION', 'test-version');

		const { configureClientErrorReporting } = await import('../error-reporting/sentry-client');
		const { startSpanObservation } = await import('../telemetry/tracing');
		const disabledObservation = startSpanObservation({ name: 'disabled' });
		expect(disabledObservation.run(() => 'ran')).toBe('ran');
		disabledObservation.finish({ status: 'ok', statusMessage: 'succeeded' });
		expect(startInactiveSpanMock).not.toHaveBeenCalled();

		configureClientErrorReporting();
		expect(initMock).toHaveBeenCalledTimes(0);

		configureClientErrorReporting({
			sentryDsn: 'https://public@example.ingest.sentry.io/123456',
			tracingSampleRate: 0.01,
			tracingSentryDsn: 'https://trace@example.ingest.sentry.io/654321',
		});
		expect(initMock).toHaveBeenCalledTimes(1);
		expect(browserTracingIntegrationMock).not.toHaveBeenCalled();
		expect(captureConsoleIntegrationMock).toHaveBeenCalledTimes(1);
		expect(initMock.mock.calls[0]?.[0]).toMatchObject({
			dsn: 'https://public@example.ingest.sentry.io/123456',
			maxBreadcrumbs: 50,
			integrations: [{ name: 'captureConsoleIntegration' }],
		});

		expect(startInactiveSpanMock).not.toHaveBeenCalled();
		expect(initMock.mock.calls[0]?.[0]).not.toHaveProperty('tracesSampleRate');
		expect(initMock.mock.calls[0]?.[0]).not.toHaveProperty('tracePropagationTargets');

		configureClientErrorReporting({
			sentryDsn: 'https://public@example.ingest.sentry.io/123456',
		});
		expect(initMock).toHaveBeenCalledTimes(1);
	});
});
