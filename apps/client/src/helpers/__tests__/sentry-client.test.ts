import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { BrowserOptions } from '@sentry/react';

const serverConfig = await import('@/runtime/server-config');
let restoreRuntimeConfig: (() => void) | undefined;

afterEach(() => {
	restoreRuntimeConfig?.();
	restoreRuntimeConfig = undefined;
});

describe('configureClientErrorReporting', () => {
	test('error SDK configuration cannot initialize tracing or redirect replay to a trace DSN', async () => {
		const initMock = mock((_options: BrowserOptions) => undefined);
		const browserTracingIntegrationMock = mock((_options: unknown) => ({
			name: 'browserTracingIntegration',
		}));
		const captureConsoleIntegrationMock = mock((_options: unknown) => ({
			name: 'captureConsoleIntegration',
		}));
		const replayIntegrationMock = mock((_options: unknown) => ({ name: 'Replay' }));
		const providerSendMock = mock(async () => ({ statusCode: 200 }));
		const makeFetchTransportMock = mock((_options: unknown) => ({ send: providerSendMock, flush: async () => true }));
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
			init: (options: BrowserOptions) => {
				sentryEnabled = true;
				initMock(options);
			},
			isEnabled: () => sentryEnabled,
			browserTracingIntegration: browserTracingIntegrationMock,
			captureConsoleIntegration: captureConsoleIntegrationMock,
			replayIntegration: replayIntegrationMock,
			makeFetchTransport: makeFetchTransportMock,
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
		expect(initMock.mock.calls[0]?.[0]).toMatchObject({
			dsn: 'https://public@example.ingest.sentry.io/123456',
			maxBreadcrumbs: 50,
			sendClientReports: false,
		});
		const options = initMock.mock.calls[0]?.[0];
		if (!options || typeof options.integrations !== 'function' || !options.transport)
			throw new Error('Missing SDK configuration');
		expect(options.integrations([{ name: 'BrowserSession' }, { name: 'GlobalHandlers' }])).toEqual([
			{ name: 'GlobalHandlers' },
			{ name: 'captureConsoleIntegration' },
		]);
		expect(captureConsoleIntegrationMock).toHaveBeenCalledTimes(1);
		const transport = options.transport({ url: 'https://unused.example', recordDroppedEvent: () => {} });
		expect(
			await transport.send([
				{ event_id: 'test', sent_at: '2026-10-12T00:00:00Z' },
				[[{ type: 'event' }, { message: 'local parser event' }]],
			]),
		).toEqual({});

		expect(startInactiveSpanMock).not.toHaveBeenCalled();
		expect(initMock.mock.calls[0]?.[0]).not.toHaveProperty('tracesSampleRate');
		expect(initMock.mock.calls[0]?.[0]).not.toHaveProperty('tracePropagationTargets');

		configureClientErrorReporting({
			sentryDsn: 'https://public@example.ingest.sentry.io/123456',
		});
		expect(initMock).toHaveBeenCalledTimes(1);

		const parserPath = '../error-reporting/sentry-client?parser-only';
		const parser: typeof import('../error-reporting/sentry-client') = await import(parserPath);
		parser.configureClientErrorReporting({
			serverRouted: true,
			replaySessionSampleRate: 1,
			replayOnErrorSampleRate: 1,
		});
		const parserOptions = initMock.mock.calls[1]?.[0];
		if (!parserOptions || typeof parserOptions.integrations !== 'function' || !parserOptions.transport)
			throw new Error('Missing parser configuration');
		expect(parserOptions).not.toHaveProperty('replaysSessionSampleRate');
		expect(parserOptions).not.toHaveProperty('replaysOnErrorSampleRate');
		expect(parserOptions.integrations([{ name: 'BrowserSession' }, { name: 'GlobalHandlers' }])).toEqual([
			{ name: 'GlobalHandlers' },
			{ name: 'captureConsoleIntegration' },
		]);
		expect(
			await parserOptions.transport({ url: 'https://telemetry.invalid', recordDroppedEvent: () => {} }).flush(),
		).toBe(true);
		expect(makeFetchTransportMock).not.toHaveBeenCalled();
		expect(replayIntegrationMock).not.toHaveBeenCalled();

		const replayPath = '../error-reporting/sentry-client?replay-enabled';
		const replay: typeof import('../error-reporting/sentry-client') = await import(replayPath);
		replay.configureClientErrorReporting({
			sentryDsn: 'https://public@example.ingest.sentry.io/123456',
			replaySessionSampleRate: 1,
		});
		const replayOptions = initMock.mock.calls[2]?.[0];
		if (!replayOptions || typeof replayOptions.integrations !== 'function' || !replayOptions.transport)
			throw new Error('Missing replay configuration');
		expect(replayOptions).toMatchObject({ replaysSessionSampleRate: 1, replaysOnErrorSampleRate: 0 });
		expect(replayOptions.integrations([])).toEqual([{ name: 'captureConsoleIntegration' }, { name: 'Replay' }]);
		expect(replayIntegrationMock).toHaveBeenCalledWith({ maskAllText: true, blockAllMedia: true });
		const replayTransport = replayOptions.transport({ url: 'https://provider.example', recordDroppedEvent: () => {} });
		expect(makeFetchTransportMock).toHaveBeenCalledTimes(1);
		await replayTransport.send([
			{},
			[
				[
					{ type: 'replay_event' },
					{ urls: [], error_ids: [], trace_ids: [], replay_id: 'test', segment_id: 0, replay_type: 'session' },
				],
				[{ type: 'replay_recording', length: 2 }, '[]'],
			],
		]);
		expect(providerSendMock).toHaveBeenCalledTimes(1);
	});
});
