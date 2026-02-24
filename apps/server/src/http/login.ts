import { ActivityLogType, type TJoinedUser } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import http from 'http';
import z from 'zod';
import { config } from '../config';
import { db } from '../db';
import { publishUser } from '../db/publishers';
import { consumeInvite, isInviteValid } from '../db/queries/invites';
import { getDefaultRole } from '../db/queries/roles';
import { getSettings } from '../db/queries/server';
import { getUserByIdentity } from '../db/queries/users';
import { userRoles, users } from '../db/schema';
import { getWsInfo } from '../helpers/get-ws-info';
import {
  hashPassword,
  isArgon2Hash,
  verifyPassword
} from '../helpers/password';
import { enqueueActivityLog } from '../queues/activity-log';
import { invariant } from '../utils/invariant';
import { issueAuthTokens } from './auth-tokens';
import { getJsonBody } from './helpers';
import { HttpValidationError } from './utils';

const LOGIN_JSON_BODY_MAX_BYTES = 16 * 1024;

const zBody = z.object({
  identity: z.string().min(1, 'Identity is required'),
  password: z.string().min(4, 'Password is required').max(128),
  invite: z.string().optional()
});

const registerUser = async (
  identity: string,
  password: string,
  inviteCode?: string,
  ip?: string
): Promise<TJoinedUser> => {
  const hashedPassword = await hashPassword(password);

  const defaultRole = await getDefaultRole();

  invariant(defaultRole, {
    code: 'NOT_FOUND',
    message: 'Default role not found'
  });

  const user = await db
    .insert(users)
    .values({
      name: 'SharkordUser',
      identity,
      createdAt: Date.now(),
      password: hashedPassword
    })
    .returning()
    .get();

  await db.insert(userRoles).values({
    roleId: defaultRole.id,
    userId: user.id,
    createdAt: Date.now()
  });

  publishUser(user.id, 'create');

  const registeredUser = await getUserByIdentity(identity);

  if (!registeredUser) {
    throw new Error('User registration failed');
  }

  if (inviteCode) {
    enqueueActivityLog({
      type: ActivityLogType.USED_INVITE,
      userId: registeredUser.id,
      details: { code: inviteCode },
      ip
    });
  }

  return registeredUser;
};

const loginRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const data = zBody.parse(
    await getJsonBody(req, { maxBytes: LOGIN_JSON_BODY_MAX_BYTES })
  );
  const settings = await getSettings();
  let existingUser = await getUserByIdentity(data.identity);
  const connectionInfo = getWsInfo(undefined, req, {
    trustProxy: config.server.trustProxy,
    trustedProxyCidrs: config.server.trustedProxyCidrs
  });

  if (!existingUser) {
    if (!settings.allowNewUsers) {
      const inviteConsumed = await consumeInvite(data.invite);

      if (!inviteConsumed) {
        const inviteError = await isInviteValid(data.invite);

        throw new HttpValidationError(
          'identity',
          inviteError || 'Invalid invite code'
        );
      }
    }

    // user doesn't exist, but registration is open OR invite was valid - create the user automatically
    existingUser = await registerUser(
      data.identity,
      data.password,
      data.invite,
      connectionInfo?.ip
    );
  }

  if (existingUser.banned) {
    throw new HttpValidationError(
      'identity',
      `Identity banned: ${existingUser.banReason || 'No reason provided'}`
    );
  }

  const passwordMatches = await verifyPassword(
    data.password,
    existingUser.password
  );

  if (!passwordMatches) {
    throw new HttpValidationError('password', 'Invalid password');
  }

  if (!isArgon2Hash(existingUser.password)) {
    const upgradedPassword = await hashPassword(data.password);

    await db
      .update(users)
      .set({ password: upgradedPassword })
      .where(eq(users.id, existingUser.id))
      .run();
  }

  const { token, refreshToken } = await issueAuthTokens(existingUser.id);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, token, refreshToken }));

  return res;
};

export { loginRouteHandler };
