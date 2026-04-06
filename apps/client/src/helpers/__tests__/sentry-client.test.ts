import { describe, expect, mock, test } from 'bun:test';

describe('configureClientErrorReporting', () => {
	test('reinitializes Sentry when the configured dsn changes', async () => {
		const initMock = mock((_options: unknown) => undefined);
		const closeMock = mock(async (_timeout: number) => true);
		let sentryEnabled = false;

		mock.module('@sentry/browser', () => ({
			init: (options: unknown) => {
				sentryEnabled = true;
				initMock(options);
			},
			isEnabled: () => sentryEnabled,
			close: async (timeout: number) => {
				sentryEnabled = false;
				return closeMock(timeout);
			},
			withScope: mock(() => undefined),
			captureException: mock(() => undefined),
		}));
		mock.module('@/runtime/server-config', () => ({
			getRuntimeServerConfig: () => ({
				source: 'web',
				serverUrl: 'https://server.example',
			}),
		}));

		Reflect.set(globalThis, 'VITE_APP_VERSION', 'test-version');

		const { configureClientErrorReporting } = await import('../error-reporting/sentry-client');

		await configureClientErrorReporting({
			sentryDsn: 'https://public@example.ingest.sentry.io/123456',
		});

		expect(initMock).toHaveBeenCalledTimes(1);
		expect(closeMock).toHaveBeenCalledTimes(0);

		await configureClientErrorReporting({
			sentryDsn: 'https://public@example.ingest.sentry.io/123456',
		});

		expect(initMock).toHaveBeenCalledTimes(1);
		expect(closeMock).toHaveBeenCalledTimes(0);

		await configureClientErrorReporting({
			sentryDsn: 'https://public@example.ingest.sentry.io/999999',
		});

		expect(closeMock).toHaveBeenCalledTimes(1);
		expect(initMock).toHaveBeenCalledTimes(2);

		await configureClientErrorReporting();

		expect(closeMock).toHaveBeenCalledTimes(2);
		expect(initMock).toHaveBeenCalledTimes(2);
	});
});
