import {
  ActivityLogType,
  ChannelPermission,
  OWNER_ROLE_ID,
  Permission,
  ServerEvents,
  type TConnectionParams,
  type TUserPresenceStatus,
  UserStatus
} from '@sharkord/shared';
import { TRPCError } from '@trpc/server';
import {
  applyWSSHandler,
  type CreateWSSContextFnOptions
} from '@trpc/server/adapters/ws';
import { eq } from 'drizzle-orm';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from '../config';
import { db } from '../db';
import { getAllChannelUserPermissions } from '../db/queries/channels';
import { getUserById, getUserByToken } from '../db/queries/users';
import { channels } from '../db/schema';
import { getWsInfo } from '../helpers/get-ws-info';
import { logger } from '../logger';
import { enqueueActivityLog } from '../queues/activity-log';
import { appRouter } from '../routers';
import { getUserRoles } from '../routers/users/get-user-roles';
import { VoiceRuntime } from '../runtimes/voice';
import { Sentry } from '../sentry';
import { invariant } from './invariant';
import { pubsub } from './pubsub';
import type { Context } from './trpc';
import {
  clearPendingVoiceDisconnect,
  getPendingVoiceReconnectChannelId,
  schedulePendingVoiceDisconnect
} from './voice-disconnect-grace';

let wss: WebSocketServer | undefined;
type TTrackedWebSocket = WebSocket & {
  userId?: number;
  token: string;
  clientInstanceId?: string;
  currentVoiceChannelId?: number;
  presenceStatus?: TUserPresenceStatus;
};

const getTrackedClients = () => {
  if (!wss) return [] as TTrackedWebSocket[];
  return Array.from(wss.clients) as TTrackedWebSocket[];
};

const hasOtherOpenUserConnection = (
  userId: number,
  currentWs: TTrackedWebSocket
) => {
  return getTrackedClients().some(
    (client) =>
      client !== currentWs &&
      client.userId === userId &&
      client.readyState === WebSocket.OPEN
  );
};

const hasOtherOpenUserVoiceConnection = (
  userId: number,
  currentWs: TTrackedWebSocket,
  channelId: number
) => {
  return getTrackedClients().some(
    (client) =>
      client !== currentWs &&
      client.userId === userId &&
      client.readyState === WebSocket.OPEN &&
      client.currentVoiceChannelId === channelId
  );
};

const hasAnyOpenUserVoiceConnection = (userId: number, channelId: number) => {
  return getTrackedClients().some(
    (client) =>
      client.userId === userId &&
      client.readyState === WebSocket.OPEN &&
      client.currentVoiceChannelId === channelId
  );
};

const usersIpMap = new Map<number, string>();

const getUserIp = (userId: number): string | undefined => {
  return usersIpMap.get(userId);
};

const createContext = async ({
  info,
  req,
  res
}: CreateWSSContextFnOptions): Promise<Context> => {
  const { token, clientInstanceId } =
    info.connectionParams as TConnectionParams;
  const connectionWs = res as TTrackedWebSocket | undefined;

  if (connectionWs) {
    connectionWs.token = token;
    connectionWs.clientInstanceId = clientInstanceId;
  }

  const decodedUser = await getUserByToken(token);

  invariant(decodedUser, {
    code: 'UNAUTHORIZED',
    message: 'Invalid authentication token'
  });

  invariant(!decodedUser.banned, {
    code: 'FORBIDDEN',
    message: 'User is banned'
  });

  if (connectionWs) {
    connectionWs.presenceStatus = decodedUser.presenceStatus;
  }

  const hasPermission = async (targetPermission: Permission | Permission[]) => {
    const user = await getUserById(decodedUser.id);

    if (!user) return false;

    const roles = await getUserRoles(user.id);

    const hasOwnerRole = roles.some((r) => r.id === OWNER_ROLE_ID);

    if (hasOwnerRole) return true; // owner always has all permissions

    const permissionsSet = new Set<Permission>();

    for (const role of roles) {
      for (const permission of role.permissions) {
        permissionsSet.add(permission);
      }
    }

    if (Array.isArray(targetPermission)) {
      return targetPermission.every((p) => permissionsSet.has(p));
    }

    return permissionsSet.has(targetPermission);
  };

  const hasChannelPermission = async (
    channelId: number,
    targetPermission: ChannelPermission
  ) => {
    const channel = await db
      .select({
        private: channels.private
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1)
      .get();

    if (!channel) return false;

    if (!channel.private) return true;

    const user = await getUserById(decodedUser.id);

    if (!user) return false;

    const roles = await getUserRoles(user.id);

    const hasOwnerRole = roles.some((r) => r.id === OWNER_ROLE_ID);

    if (hasOwnerRole) return true; // owner always has all permissions

    const userChannelPermissions = await getAllChannelUserPermissions(
      decodedUser.id
    );

    const channelInfo = userChannelPermissions[channelId];

    if (!channelInfo) return false;
    if (!channelInfo.permissions[ChannelPermission.VIEW_CHANNEL]) return false;

    return channelInfo.permissions[targetPermission] === true;
  };

  const isCurrentClient = (client: TTrackedWebSocket) =>
    client.token === token && client.clientInstanceId === clientInstanceId;

  const getOwnWs = () => {
    if (!wss) return undefined;
    if (connectionWs) return connectionWs;
    return getTrackedClients().find(isCurrentClient);
  };

  const getUserWs = (userId: number) => {
    if (!wss) return undefined;
    return getTrackedClients().find((client) => client.userId === userId);
  };

  const getUserWss = (userId: number) => {
    if (!wss) return [];

    return getTrackedClients().filter(
      (client) =>
        client.userId === userId && client.readyState === WebSocket.OPEN
    );
  };

  const getStatusById = (userId: number) => {
    if (!wss) return UserStatus.OFFLINE;

    const userConnections = getTrackedClients().filter(
      (ws) => ws.userId === userId && ws.readyState === WebSocket.OPEN
    );

    if (userConnections.length === 0) {
      return UserStatus.OFFLINE;
    }

    const isAway = userConnections.some(
      (ws) => ws.presenceStatus === UserStatus.AWAY
    );

    return isAway ? UserStatus.AWAY : UserStatus.ONLINE;
  };

  const setUserPresenceStatus = (status: TUserPresenceStatus) => {
    if (!wss) return;

    for (const ws of getTrackedClients()) {
      if (ws.userId === decodedUser.id) {
        ws.presenceStatus = status;
      }
    }
  };

  const setWsUserId = (userId: number) => {
    if (connectionWs) {
      connectionWs.userId = userId;
      return;
    }

    if (!wss) return;

    const ws = getTrackedClients().find(isCurrentClient);

    if (ws) {
      ws.userId = userId;
    }
  };

  const setWsVoiceChannelId = (channelId: number | undefined) => {
    if (connectionWs) {
      connectionWs.currentVoiceChannelId = channelId;
      if (channelId !== undefined) {
        clearPendingVoiceDisconnect(
          connectionWs.clientInstanceId,
          decodedUser.id
        );
      }
      return;
    }

    if (!wss) return;

    const ws = getTrackedClients().find(
      (client) => isCurrentClient(client) && client.userId === decodedUser.id
    );

    if (ws) {
      ws.currentVoiceChannelId = channelId;
      if (channelId !== undefined) {
        clearPendingVoiceDisconnect(ws.clientInstanceId, decodedUser.id);
      }
    }
  };

  const getConnectionInfo = () => {
    if (!wss) {
      return getWsInfo(undefined, req, {
        trustProxy: config.server.trustProxy
      });
    }

    const ws = connectionWs ?? getTrackedClients().find(isCurrentClient);

    if (!ws) return undefined;

    return getWsInfo(ws, req, {
      trustProxy: config.server.trustProxy
    });
  };

  const needsPermission = async (
    targetPermission: Permission | Permission[]
  ) => {
    invariant(await hasPermission(targetPermission), {
      code: 'FORBIDDEN',
      message: 'Insufficient permissions'
    });
  };

  const needsChannelPermission = async (
    channelId: number,
    targetPermission: ChannelPermission
  ) => {
    invariant(await hasChannelPermission(channelId, targetPermission), {
      code: 'FORBIDDEN',
      message: 'Insufficient channel permissions'
    });
  };

  const throwValidationError = (field: string, message: string) => {
    // this mimics the zod validation error format
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: JSON.stringify([
        {
          code: 'custom',
          path: [field],
          message
        }
      ])
    });
  };

  const saveUserIp = async (userId: number, ip: string) => {
    usersIpMap.set(userId, ip);
  };

  return {
    pubsub,
    token,
    user: decodedUser,
    authenticated: false,
    userId: decodedUser.id,
    handshakeHash: '',
    currentVoiceChannelId: undefined,
    getPendingVoiceReconnectChannelId: () =>
      getPendingVoiceReconnectChannelId(
        connectionWs?.clientInstanceId ?? clientInstanceId,
        decodedUser.id
      ),
    hasPermission,
    needsPermission,
    hasChannelPermission,
    needsChannelPermission,
    getOwnWs,
    getStatusById,
    setUserPresenceStatus,
    setWsUserId,
    setWsVoiceChannelId,
    getUserWs,
    getUserWss,
    getConnectionInfo,
    throwValidationError,
    saveUserIp
  };
};

const createWsServer = async (server: http.Server) => {
  return new Promise<WebSocketServer>((resolve) => {
    const corsOrigin = config.server.corsOrigin;
    wss = new WebSocketServer({
      server,
      verifyClient: corsOrigin
        ? ({ origin }: { origin?: string }) => origin === corsOrigin
        : undefined
    });

    wss.on('connection', (ws) => {
      const trackedWs = ws as TTrackedWebSocket;
      trackedWs.userId = undefined;
      trackedWs.token = '';
      trackedWs.clientInstanceId = undefined;
      trackedWs.currentVoiceChannelId = undefined;
      trackedWs.presenceStatus = UserStatus.ONLINE;

      trackedWs.once('message', async (message) => {
        try {
          const parsed = JSON.parse(message.toString());
          const { token, clientInstanceId } = parsed.data as TConnectionParams;

          trackedWs.token = token;
          trackedWs.clientInstanceId = clientInstanceId;
        } catch {
          logger.error('Failed to parse initial WebSocket message');
        }
      });

      trackedWs.on('close', async (wsCloseCode) => {
        if (!trackedWs.userId) return;

        const userId = trackedWs.userId;
        const hasOtherConnections = hasOtherOpenUserConnection(
          userId,
          trackedWs
        );
        const hasOtherVoiceConnection =
          trackedWs.currentVoiceChannelId !== undefined
            ? hasOtherOpenUserVoiceConnection(
                userId,
                trackedWs,
                trackedWs.currentVoiceChannelId
              )
            : false;

        let voiceRuntime: VoiceRuntime | undefined;

        if (
          trackedWs.currentVoiceChannelId !== undefined &&
          !hasOtherVoiceConnection
        ) {
          voiceRuntime = VoiceRuntime.findById(trackedWs.currentVoiceChannelId);
        } else if (!hasOtherConnections) {
          // Fallback for sessions that may not have tracked voice channel state.
          voiceRuntime = VoiceRuntime.findRuntimeByUserId(userId);
        }

        if (voiceRuntime?.getUser(userId)) {
          const channelId = voiceRuntime.id;
          const clientInstanceId = trackedWs.clientInstanceId;
          const finalizeVoiceDisconnect = () => {
            if (hasAnyOpenUserVoiceConnection(userId, channelId)) {
              return;
            }

            const latestVoiceRuntime = VoiceRuntime.findById(channelId);

            if (!latestVoiceRuntime?.getUser(userId)) {
              return;
            }

            latestVoiceRuntime.removeUser(userId);

            pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
              channelId,
              userId
            });
          };

          schedulePendingVoiceDisconnect({
            clientInstanceId,
            userId,
            channelId,
            wsCloseCode,
            finalize: finalizeVoiceDisconnect
          });
        }

        trackedWs.currentVoiceChannelId = undefined;

        if (hasOtherConnections) {
          logger.debug(
            'User %s disconnected from one session, but is still connected elsewhere',
            userId
          );
          return;
        }

        const user = await getUserById(userId);

        if (!user) return;

        usersIpMap.delete(userId);
        pubsub.publish(ServerEvents.USER_LEAVE, userId);

        logger.info('%s left the server', user.name);

        enqueueActivityLog({
          type: ActivityLogType.USER_LEFT,
          userId
        });
      });

      trackedWs.on('error', (err) => {
        logger.error('WebSocket client error:', err);
      });
    });

    wss.on('close', () => {
      logger.debug('WebSocket server closed');
    });

    wss.on('error', (err) => {
      logger.error('WebSocket server error:', err);
    });

    applyWSSHandler({
      wss,
      router: appRouter,
      createContext,
      onError: ({ error, path }) => {
        if (error.code === 'INTERNAL_SERVER_ERROR') {
          Sentry.captureException(error.cause ?? error, { extra: { path } });
        }
      }
    });

    resolve(wss);
  });
};

export { createContext, createWsServer, getUserIp };
