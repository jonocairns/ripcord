import { describe, expect, mock, test } from 'bun:test';

describe('configureClientErrorReporting', () => {
	test('initializes Sentry once when a dsn is provided and skips when empty', async () => {
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
		mock.module('@/runtime/server-config', () => ({
			getRuntimeServerConfig: () => ({
				source: 'web',
				serverUrl: 'https://server.example',
			}),
		}));

		Reflect.set(globalThis, 'VITE_APP_VERSION', 'test-version');

		const { configureClientErrorReporting, startSentrySpanObservation } = await import(
			'../error-reporting/sentry-client'
		);
		const disabledObservation = startSentrySpanObservation({ name: 'disabled' });
		expect(disabledObservation.run(() => 'ran')).toBe('ran');
		disabledObservation.finish({ status: 'ok', statusMessage: 'succeeded' });
		expect(startInactiveSpanMock).not.toHaveBeenCalled();

		configureClientErrorReporting();
		expect(initMock).toHaveBeenCalledTimes(0);

		configureClientErrorReporting({
			sentryDsn: 'https://public@example.ingest.sentry.io/123456',
			tracingSampleRate: 0.01,
		});
		expect(initMock).toHaveBeenCalledTimes(1);
		expect(browserTracingIntegrationMock).toHaveBeenCalledTimes(1);
		expect(captureConsoleIntegrationMock).toHaveBeenCalledTimes(1);
		expect(initMock.mock.calls[0]?.[0]).toMatchObject({
			tracesSampleRate: 0.01,
			tracePropagationTargets: ['https://server.example'],
			maxBreadcrumbs: 50,
			integrations: [{ name: 'captureConsoleIntegration' }, { name: 'browserTracingIntegration' }],
		});

		const observation = startSentrySpanObservation({ name: 'voice.session_command', op: 'voice.session' });
		expect(observation.run(() => 'observed')).toBe('observed');
		observation.finish({
			attributes: { 'voice.outcome': 'succeeded', 'voice.duration_ms': 25 },
			status: 'ok',
			statusMessage: 'succeeded',
		});
		observation.finish({ status: 'error', statusMessage: 'failed' });
		expect(startInactiveSpanMock).toHaveBeenCalledTimes(1);
		expect(spanSetAttributesMock).toHaveBeenCalledWith({
			'voice.outcome': 'succeeded',
			'voice.duration_ms': 25,
		});
		expect(spanSetStatusMock).toHaveBeenCalledWith({ code: 1, message: 'succeeded' });
		expect(spanEndMock).toHaveBeenCalledTimes(1);

		configureClientErrorReporting({
			sentryDsn: 'https://public@example.ingest.sentry.io/123456',
		});
		expect(initMock).toHaveBeenCalledTimes(1);
	});
});
