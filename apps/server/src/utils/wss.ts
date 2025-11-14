import {
  ActivityLogType,
  OWNER_ROLE_ID,
  Permission,
  ServerEvents,
  UserStatus,
  type TConnectionParams
} from '@sharkord/shared';
import { TRPCError } from '@trpc/server';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import http from 'http';
import { WebSocketServer } from 'ws';
import { getUserById } from '../db/queries/users/get-user-by-id';
import { getUserByToken } from '../db/queries/users/get-user-by-token';
import { getUserRole } from '../db/queries/users/get-user-role';
import { getWsInfo } from '../helpers/get-ws-info';
import { logger } from '../logger';
import { enqueueActivityLog } from '../queues/activity-log';
import { appRouter } from '../routers';
import { VoiceRuntime } from '../runtimes/voice';
import { pubsub } from './pubsub';

let wss: WebSocketServer;

const usersIpMap = new Map<number, string>();

const getUserIp = (userId: number): string | undefined => {
  return usersIpMap.get(userId);
};

const createWsServer = async (server: http.Server) => {
  return new Promise<WebSocketServer>((resolve) => {
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      ws.userId = undefined;
      ws.token = '';

      ws.once('message', async (message) => {
        try {
          const parsed = JSON.parse(message.toString());
          const { token } = parsed.data as TConnectionParams;

          ws.token = token;
        } catch {
          logger.error('Failed to parse initial WebSocket message');
        }
      });

      ws.on('close', async () => {
        const user = await getUserByToken(ws.token);

        if (!user) return;

        const voiceRuntime = VoiceRuntime.findRuntimeByUserId(user.id);

        if (voiceRuntime) {
          voiceRuntime.removeUser(user.id);

          pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
            channelId: voiceRuntime.id,
            userId: user.id
          });
        }

        usersIpMap.delete(user.id);
        pubsub.publish(ServerEvents.USER_LEAVE, user.id);

        logger.info('%s left the server', user.name);

        enqueueActivityLog({
          type: ActivityLogType.USER_LEFT,
          userId: user.id
        });
      });

      ws.on('error', (err) => {
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
      createContext: async ({ info, req }) => {
        const { token } = info.connectionParams as TConnectionParams;

        const decodedUser = await getUserByToken(token);

        if (!decodedUser) {
          throw new TRPCError({ code: 'UNAUTHORIZED' });
        }

        if (decodedUser.banned) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'User is banned' });
        }

        const hasPermission = async (
          targetPermission: Permission | Permission[]
        ) => {
          const user = await getUserById(decodedUser.id);

          if (!user) return false;

          if (user.roleId === OWNER_ROLE_ID) return true; // owner always has all permissions

          const role = await getUserRole(user.id);

          if (!role) return false;

          if (Array.isArray(targetPermission)) {
            return targetPermission.every((p) => role.permissions.includes(p));
          }

          return role.permissions.includes(targetPermission);
        };

        const getOwnWs = () => {
          return Array.from(wss.clients).find(
            (client) => client.token === token
          );
        };

        const getUserWs = (userId: number) => {
          return Array.from(wss.clients).find(
            (client) => client.userId === userId
          );
        };

        const getStatusById = (userId: number) => {
          const isConnected = Array.from(wss.clients).some(
            (ws) => ws.userId === userId
          );

          return isConnected ? UserStatus.ONLINE : UserStatus.OFFLINE;
        };

        const setWsUserId = (userId: number) => {
          const ws = Array.from(wss.clients).find(
            (client) => client.token === token
          );

          if (ws) {
            ws.userId = userId;
          }
        };

        const getConnectionInfo = () => {
          const ws = Array.from(wss.clients).find(
            (client) => client.token === token
          );

          if (!ws) return undefined;

          return getWsInfo(ws, req);
        };

        const needsPermission = async (
          targetPermission: Permission | Permission[]
        ) => {
          if (!(await hasPermission(targetPermission))) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Insufficient permissions'
            });
          }
        };

        const throwValidationError = (field: string, message: string) => {
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
          hasPermission,
          getOwnWs,
          getStatusById,
          setWsUserId,
          needsPermission,
          getUserWs,
          getConnectionInfo,
          throwValidationError,
          saveUserIp
        };
      }
    });

    resolve(wss);
  });
};

export { createWsServer, getUserIp };
