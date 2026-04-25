import { describe, expect, mock, test } from 'bun:test';

describe('configureClientErrorReporting', () => {
	test('initializes Sentry once when a dsn is provided and skips when empty', async () => {
		const initMock = mock((_options: unknown) => undefined);
		let sentryEnabled = false;

		mock.module('@sentry/react', () => ({
			init: (options: unknown) => {
				sentryEnabled = true;
				initMock(options);
			},
			isEnabled: () => sentryEnabled,
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

		const { configureClientErrorReporting } = await import('../error-reporting/sentry-client');

		configureClientErrorReporting();
		expect(initMock).toHaveBeenCalledTimes(0);

		configureClientErrorReporting({
			sentryDsn: 'https://public@example.ingest.sentry.io/123456',
		});
		expect(initMock).toHaveBeenCalledTimes(1);

		configureClientErrorReporting({
			sentryDsn: 'https://public@example.ingest.sentry.io/123456',
		});
		expect(initMock).toHaveBeenCalledTimes(1);
	});
});
