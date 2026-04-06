import http from 'http';
import { config } from '../config';
import { getErrorMessage } from '../helpers/get-error-message';
import { logger } from '../logger';
import { getRawBody } from './helpers';
import { getEnvelopeHeaderDsn } from './sentry-envelope-header';
import { getSentryEnvelopeForwardUrl } from './sentry-envelope-url';

const SENTRY_TUNNEL_MAX_BODY_BYTES = 256 * 1024;

const sentryTunnelRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const sentryDsn = config.server.clientErrorReportingSentryDsn.trim();

  if (!sentryDsn) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: 'Client error reporting is not configured.' })
    );
    return;
  }

  const body = await getRawBody(req, {
    maxBytes: SENTRY_TUNNEL_MAX_BODY_BYTES
  });
  const envelopeHeaderDsn = getEnvelopeHeaderDsn(body);

  if (envelopeHeaderDsn && envelopeHeaderDsn !== sentryDsn) {
    logger.warn('[sentry-tunnel] Rejected envelope with mismatched DSN header');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Envelope DSN does not match server configuration.'
      })
    );
    return;
  }

  let response: Response;

  try {
    response = await fetch(getSentryEnvelopeForwardUrl(sentryDsn), {
      method: 'POST',
      headers: {
        'Content-Type':
          typeof req.headers['content-type'] === 'string'
            ? req.headers['content-type']
            : 'application/x-sentry-envelope'
      },
      body
    });
  } catch (error) {
    logger.error(
      '[sentry-tunnel] Failed to forward client error report: %s',
      getErrorMessage(error)
    );
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: 'Failed to forward client error report.' })
    );
    return;
  }

  if (!response.ok) {
    const responseText = await response.text();

    logger.warn(
      '[sentry-tunnel] Upstream responded with %d: %s',
      response.status,
      responseText
    );
  }

  res.writeHead(response.status || 200);
  res.end();
};

export { sentryTunnelRouteHandler };
