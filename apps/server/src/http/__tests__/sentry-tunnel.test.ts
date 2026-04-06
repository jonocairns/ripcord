import { describe, expect, mock, test } from 'bun:test';
import type http from 'http';
import { getEnvelopeHeaderDsn } from '../sentry-envelope-header';
import { getSentryEnvelopeForwardUrl } from '../sentry-envelope-url';

describe('getSentryEnvelopeForwardUrl', () => {
  test('builds the envelope endpoint from a standard sentry dsn', () => {
    expect(
      getSentryEnvelopeForwardUrl(
        'https://public@example.ingest.sentry.io/123456'
      )
    ).toBe('https://example.ingest.sentry.io/api/123456/envelope/');
  });

  test('preserves self-hosted path prefixes before the project id', () => {
    expect(
      getSentryEnvelopeForwardUrl(
        'https://public@sentry.example.com/custom/path/987654'
      )
    ).toBe('https://sentry.example.com/custom/path/api/987654/envelope/');
  });
});

describe('getEnvelopeHeaderDsn', () => {
  test('reads the dsn from the envelope header line', () => {
    expect(
      getEnvelopeHeaderDsn(
        new TextEncoder().encode(
          '{"dsn":"https://public@example.ingest.sentry.io/123456"}\n{"type":"event"}'
        )
      )
    ).toBe('https://public@example.ingest.sentry.io/123456');
  });

  test('returns undefined for malformed envelope headers', () => {
    expect(
      getEnvelopeHeaderDsn(new TextEncoder().encode('not-json'))
    ).toBeUndefined();
  });
});

describe('sentryTunnelRouteHandler', () => {
  test('returns 400 when the envelope dsn does not match the server configuration', async () => {
    const getRawBodyMock = mock(async () =>
      new TextEncoder().encode(
        '{"dsn":"https://public@example.ingest.sentry.io/999999"}\n{"type":"event"}'
      )
    );
    const loggerWarnMock = mock(() => {});
    const originalFetch = globalThis.fetch;

    mock.module('../../config', () => ({
      config: {
        server: {
          clientErrorReportingSentryDsn:
            'https://public@example.ingest.sentry.io/123456'
        }
      }
    }));
    mock.module('../../helpers/get-error-message', () => ({
      getErrorMessage: (error: unknown) =>
        error instanceof Error ? error.message : String(error)
    }));
    mock.module('../../logger', () => ({
      logger: {
        error: mock(() => {}),
        warn: loggerWarnMock,
        info: mock(() => {}),
        debug: mock(() => {})
      }
    }));
    mock.module('../helpers', () => ({
      getRawBody: getRawBodyMock
    }));

    globalThis.fetch = mock(async () => {
      throw new Error('fetch should not be called');
    }) as unknown as typeof fetch;

    try {
      const { sentryTunnelRouteHandler } = await import('../sentry-tunnel');
      const writeHead = mock(() => undefined);
      const end = mock(() => undefined);

      await sentryTunnelRouteHandler(
        {
          headers: {}
        } as http.IncomingMessage,
        {
          writeHead,
          end
        } as unknown as http.ServerResponse
      );

      expect(getRawBodyMock).toHaveBeenCalledTimes(1);
      expect(writeHead).toHaveBeenCalledWith(400, {
        'Content-Type': 'application/json'
      });
      expect(end).toHaveBeenCalledWith(
        JSON.stringify({
          error: 'Envelope DSN does not match server configuration.'
        })
      );
      expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns 502 when forwarding the envelope fails', async () => {
    const getRawBodyMock = mock(async () => new Uint8Array([1, 2, 3]));
    const loggerErrorMock = mock(() => {});
    const originalFetch = globalThis.fetch;

    mock.module('../../config', () => ({
      config: {
        server: {
          clientErrorReportingSentryDsn:
            'https://public@example.ingest.sentry.io/123456'
        }
      }
    }));
    mock.module('../../helpers/get-error-message', () => ({
      getErrorMessage: (error: unknown) =>
        error instanceof Error ? error.message : String(error)
    }));
    mock.module('../../logger', () => ({
      logger: {
        error: loggerErrorMock,
        warn: mock(() => {}),
        info: mock(() => {}),
        debug: mock(() => {})
      }
    }));
    mock.module('../helpers', () => ({
      getRawBody: getRawBodyMock
    }));

    globalThis.fetch = mock(() =>
      Promise.reject(new Error('network down'))
    ) as unknown as typeof fetch;

    try {
      const { sentryTunnelRouteHandler } = await import('../sentry-tunnel');
      const writeHead = mock(() => undefined);
      const end = mock(() => undefined);

      await sentryTunnelRouteHandler(
        {
          headers: {}
        } as http.IncomingMessage,
        {
          writeHead,
          end
        } as unknown as http.ServerResponse
      );

      expect(getRawBodyMock).toHaveBeenCalledTimes(1);
      expect(writeHead).toHaveBeenCalledWith(502, {
        'Content-Type': 'application/json'
      });
      expect(end).toHaveBeenCalledWith(
        JSON.stringify({ error: 'Failed to forward client error report.' })
      );
      expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
