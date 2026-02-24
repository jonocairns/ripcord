import chalk from 'chalk';
import http from 'http';
import z from 'zod';
import { config } from '../config';
import { getWsInfo } from '../helpers/get-ws-info';
import {
  getAllowedOrigin,
  isOriginAllowedForRequest,
  normalizeOrigin,
  parseAllowedOrigins
} from '../helpers/origin';
import { logger } from '../logger';
import {
  createRateLimiter,
  getClientRateLimitKey,
  getRateLimitRetrySeconds
} from '../utils/rate-limiters/rate-limiter';
import { healthRouteHandler } from './healthz';
import { infoRouteHandler } from './info';
import { interfaceRouteHandler } from './interface';
import { loginRouteHandler } from './login';
import { logoutRouteHandler } from './logout';
import { publicRouteHandler } from './public';
import { refreshRouteHandler } from './refresh';
import { uploadFileRouteHandler } from './upload';
import { HttpBodyTooLargeError, HttpValidationError } from './utils';

// 5 attempts per minute per IP for login route
const loginRateLimiter = createRateLimiter({
  maxRequests: config.rateLimiters.joinServer.maxRequests,
  windowMs: config.rateLimiters.joinServer.windowMs
});

// 10 attempts per minute per IP for refresh route
const refreshRateLimiter = createRateLimiter({
  maxRequests: 10,
  windowMs: 60_000
});

// 20 attempts per minute per IP for logout route
const logoutRateLimiter = createRateLimiter({
  maxRequests: 20,
  windowMs: 60_000
});

// 20 upload attempts per minute per IP (or shared unknown bucket if IP is unavailable)
const uploadRateLimiter = createRateLimiter({
  maxRequests: 20,
  windowMs: 60_000
});

// 120 public-file requests per minute per IP
const publicRouteRateLimiter = createRateLimiter({
  maxRequests: 120,
  windowMs: 60_000
});

// 240 interface/static file requests per minute per IP
const interfaceRouteRateLimiter = createRateLimiter({
  maxRequests: 240,
  windowMs: 60_000
});

const corsAllowedOrigins = parseAllowedOrigins(config.server.allowedOrigins);

const setDefaultSecurityHeaders = (res: http.ServerResponse) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(self), geolocation=(), payment=()'
  );
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
  );
};

// this http server implementation is temporary and will be moved to bun server later when things are more stable
const createHttpServer = async (port: number = config.server.port) => {
  return new Promise<http.Server>((resolve) => {
    const server = http.createServer(
      async (req: http.IncomingMessage, res: http.ServerResponse) => {
        setDefaultSecurityHeaders(res);

        const requestOrigin = normalizeOrigin(req.headers.origin);
        const allowedOrigin = getAllowedOrigin(requestOrigin, corsAllowedOrigins);
        const originAllowedForRequest = isOriginAllowedForRequest({
          requestOrigin,
          requestHost: req.headers.host,
          allowedOrigins: corsAllowedOrigins
        });

        if (allowedOrigin) {
          res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, X-Token, X-File-Name, X-File-Type, Content-Length'
          );
          res.setHeader('Access-Control-Max-Age', '600');

          if (allowedOrigin !== '*') {
            res.setHeader('Vary', 'Origin');
          }
        }

        const info = getWsInfo(undefined, req, {
          trustProxy: config.server.trustProxy,
          trustedProxyCidrs: config.server.trustedProxyCidrs
        });

        logger.debug(
          `${chalk.dim('[HTTP]')} ${req.method} ${req.url} - ${info?.ip}`
        );

        if (req.method === 'OPTIONS') {
          if (requestOrigin && !originAllowedForRequest) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'CORS origin forbidden' }));
            return;
          }

          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method !== 'GET' && requestOrigin && !originAllowedForRequest) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CORS origin forbidden' }));
          return;
        }

        try {
          if (req.method === 'GET' && req.url === '/healthz') {
            return await healthRouteHandler(req, res);
          }

          if (req.method === 'GET' && req.url === '/info') {
            return await infoRouteHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/upload') {
            const key = getClientRateLimitKey(info?.ip);
            const rateLimit = uploadRateLimiter.consume(key);

            if (!rateLimit.allowed) {
              logger.debug(
                `${chalk.dim('[Rate Limiter HTTP]')} /upload rate limited for key "${key}"`
              );

              res.setHeader(
                'Retry-After',
                getRateLimitRetrySeconds(rateLimit.retryAfterMs)
              );

              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'Too many upload attempts. Please try again shortly.'
                })
              );

              return;
            }

            return await uploadFileRouteHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/login') {
            const key = getClientRateLimitKey(info?.ip);
            const rateLimit = loginRateLimiter.consume(key);

            if (!rateLimit.allowed) {
              logger.debug(
                `${chalk.dim('[Rate Limiter HTTP]')} /login rate limited for key "${key}"`
              );

              res.setHeader(
                'Retry-After',
                getRateLimitRetrySeconds(rateLimit.retryAfterMs)
              );

              res.writeHead(429, { 'Content-Type': 'application/json' });

              res.end(
                JSON.stringify({
                  error: 'Too many login attempts. Please try again shortly.'
                })
              );

              return;
            }

            return await loginRouteHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/refresh') {
            const key = getClientRateLimitKey(info?.ip);
            const rateLimit = refreshRateLimiter.consume(key);

            if (!rateLimit.allowed) {
              logger.debug(
                `${chalk.dim('[Rate Limiter HTTP]')} /refresh rate limited for key "${key}"`
              );

              res.setHeader(
                'Retry-After',
                getRateLimitRetrySeconds(rateLimit.retryAfterMs)
              );

              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'Too many refresh attempts. Please try again shortly.'
                })
              );
              return;
            }

            return await refreshRouteHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/logout') {
            const key = getClientRateLimitKey(info?.ip);
            const rateLimit = logoutRateLimiter.consume(key);

            if (!rateLimit.allowed) {
              logger.debug(
                `${chalk.dim('[Rate Limiter HTTP]')} /logout rate limited for key "${key}"`
              );

              res.setHeader(
                'Retry-After',
                getRateLimitRetrySeconds(rateLimit.retryAfterMs)
              );

              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'Too many logout attempts. Please try again shortly.'
                })
              );
              return;
            }

            return await logoutRouteHandler(req, res);
          }

          if (req.method === 'GET' && req.url?.startsWith('/public')) {
            const key = getClientRateLimitKey(info?.ip);
            const rateLimit = publicRouteRateLimiter.consume(key);

            if (!rateLimit.allowed) {
              logger.debug(
                `${chalk.dim('[Rate Limiter HTTP]')} /public rate limited for key "${key}"`
              );

              res.setHeader(
                'Retry-After',
                getRateLimitRetrySeconds(rateLimit.retryAfterMs)
              );

              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'Too many file requests. Please try again shortly.'
                })
              );
              return;
            }

            return await publicRouteHandler(req, res);
          }

          if (req.method === 'GET' && req.url?.startsWith('/')) {
            const key = getClientRateLimitKey(info?.ip);
            const rateLimit = interfaceRouteRateLimiter.consume(key);

            if (!rateLimit.allowed) {
              logger.debug(
                `${chalk.dim('[Rate Limiter HTTP]')} / interface rate limited for key "${key}"`
              );

              res.setHeader(
                'Retry-After',
                getRateLimitRetrySeconds(rateLimit.retryAfterMs)
              );

              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'Too many requests. Please try again shortly.'
                })
              );
              return;
            }

            return await interfaceRouteHandler(req, res);
          }
        } catch (error) {
          const errorsMap: Record<string, string> = {};

          if (error instanceof z.ZodError) {
            for (const issue of error.issues) {
              const field = issue.path[0];

              if (typeof field === 'string') {
                errorsMap[field] = issue.message;
              }
            }

            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ errors: errorsMap }));
            return;
          } else if (error instanceof HttpValidationError) {
            errorsMap[error.field] = error.message;

            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ errors: errorsMap }));
            return;
          } else if (error instanceof HttpBodyTooLargeError) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: `Request body too large. Maximum size is ${error.maxBytes} bytes.`
              })
            );
            return;
          }

          logger.error('HTTP route error:', error);

          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    );

    server.on('listening', () => {
      logger.debug('HTTP server is listening on port %d', port);
      resolve(server);
    });

    server.requestTimeout = config.server.httpRequestTimeoutMs;
    server.headersTimeout = config.server.httpHeadersTimeoutMs;
    server.keepAliveTimeout = config.server.httpKeepAliveTimeoutMs;
    server.maxHeadersCount = config.server.maxHttpHeadersCount;

    server.on('clientError', (error, socket) => {
      logger.warn('HTTP client connection error: %s', error.message);

      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      }
    });

    server.on('close', () => {
      logger.debug('HTTP server closed');
      process.exit(0);
    });

    server.listen(port);
  });
};

export { createHttpServer };
