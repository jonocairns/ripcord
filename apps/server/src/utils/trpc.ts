import {
  ChannelPermission,
  UserStatus,
  type Permission,
  type TUser
} from '@sharkord/shared';
import { initTRPC, TRPCError } from '@trpc/server';
import chalk from 'chalk';
import type WebSocket from 'ws';
import { config } from '../config';
import { logger } from '../logger';
import type { TConnectionInfo } from '../types';
import { invariant } from './invariant';
import { pubsub } from './pubsub';
import {
  createRateLimiter,
  getClientRateLimitKey
} from './rate-limiters/rate-limiter';

export type Context = {
  handshakeHash: string;
  authenticated: boolean;
  pubsub: typeof pubsub;
  user: Omit<TUser, 'totpSecret' | 'totpRecoveryCodes'>;
  userId: number;
  token: string;
  currentVoiceChannelId: number | undefined;
  hasPermission: (
    targetPermission: Permission | Permission[]
  ) => Promise<boolean>;
  needsPermission: (
    targetPermission: Permission | Permission[]
  ) => Promise<void>;
  hasChannelPermission: (
    channelId: number,
    targetPermission: ChannelPermission
  ) => Promise<boolean>;
  needsChannelPermission: (
    channelId: number,
    targetPermission: ChannelPermission
  ) => Promise<void>;
  getOwnWs: () => WebSocket | undefined;
  getStatusById: (userId: number) => UserStatus;
  setWsUserId: (userId: number) => void;
  setWsVoiceChannelId: (channelId: number | undefined) => void;
  getUserWs: (userId: number) => WebSocket | undefined;
  getUserWss: (userId: number) => WebSocket[];
  getConnectionInfo: () => TConnectionInfo | undefined;
  throwValidationError: (field: string, message: string) => never;
  saveUserIp: (userId: number, ip: string) => Promise<void>;
};

const t = initTRPC.context<Context>().create();

const timingMiddleware = t.middleware(async ({ path, next }) => {
  if (!config.server.debug) {
    return next();
  }

  const start = performance.now();
  const result = await next();
  const end = performance.now();
  const duration = end - start;

  logger.debug(
    `${chalk.dim('[tRPC]')} ${chalk.yellow(path)} took ${chalk.green(duration.toFixed(2))} ms`
  );

  return result;
});

const authMiddleware = t.middleware(async ({ ctx, next }) => {
  invariant(ctx.authenticated, {
    code: 'UNAUTHORIZED',
    message: 'You must be authenticated to perform this action.'
  });

  return next();
});

const PASSWORD_RESET_REQUIRED_ALLOWED_PATHS = new Set(['users.updatePassword']);

const passwordResetRequiredMiddleware = t.middleware(
  async ({ ctx, next, path }) => {
    if (!ctx.user.mustChangePassword) {
      return next();
    }

    if (PASSWORD_RESET_REQUIRED_ALLOWED_PATHS.has(path)) {
      return next();
    }

    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You must change your password before using the server.'
    });
  }
);

type TRateLimitedProcedureOptions = {
  maxRequests: number;
  windowMs: number;
  logLabel: string;
  maxEntries?: number;
  keyBy?: 'ip' | 'user' | 'userOrIp';
};

const rateLimitedProcedure = (
  procedure: typeof t.procedure,
  options: TRateLimitedProcedureOptions
) => {
  const keyBy = options.keyBy ?? 'userOrIp';

  const limiter = createRateLimiter({
    maxRequests: options.maxRequests,
    windowMs: options.windowMs,
    maxEntries: options.maxEntries
  });

  const rateLimitMiddleware = t.middleware(async ({ ctx, next, path }) => {
    const hasUserId = Number.isInteger(ctx.userId) && ctx.userId > 0;
    const connectionInfo = ctx.getConnectionInfo();
    const hasIp = !!connectionInfo?.ip;

    let key: string | undefined;

    if (keyBy === 'user') {
      if (hasUserId) {
        key = `user:${ctx.userId}`;
      }
    } else if (keyBy === 'ip') {
      if (hasIp) {
        key = getClientRateLimitKey(connectionInfo.ip!);
      }
    } else {
      if (hasUserId) {
        key = `user:${ctx.userId}`;
      } else if (hasIp) {
        key = getClientRateLimitKey(connectionInfo.ip!);
      }
    }

    if (!key) {
      logger.warn(
        `${chalk.dim('[Rate Limiter tRPC]')} No rate-limit key available (${keyBy}), skipping request. Path: ${path}`
      );
      return next();
    }

    const rateLimit = limiter.consume(key);

    if (!rateLimit.allowed) {
      logger.debug(
        `${chalk.dim('[Rate Limiter tRPC]')} ${options.logLabel} rate limited for key "${key}"`
      );

      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests. Please try again shortly.'
      });
    }

    return next();
  });

  return procedure.use(rateLimitMiddleware);
};

// this should be used for all queries and mutations apart from the join server one
// it prevents users that only are connected to the wss but did not join the server from accessing protected procedures
const protectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(authMiddleware)
  .use(passwordResetRequiredMiddleware);

const publicProcedure = t.procedure.use(timingMiddleware);

export { protectedProcedure, publicProcedure, rateLimitedProcedure, t };
