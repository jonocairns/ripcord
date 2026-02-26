import { sha256 } from '@sharkord/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { login, logout, refresh } from '../../__tests__/helpers';
import { TEST_SECRET_TOKEN } from '../../__tests__/seed';
import { tdb } from '../../__tests__/setup';
import {
  invites,
  refreshTokens,
  roles,
  settings,
  userRoles,
  users
} from '../../db/schema';

type TLoginResponse = {
  success?: boolean;
  token: string;
  refreshToken: string;
  error?: string;
  errors: Record<string, string>;
};

describe('/login', () => {
  test('should successfully login with valid credentials', async () => {
    const response = await login('testowner', 'password123');

    expect(response.status).toBe(200);

    const data = (await response.json()) as { success: boolean; token: string };

    expect(data).toHaveProperty('success', true);
    expect(data).toHaveProperty('token');
    expect(data).toHaveProperty('refreshToken');

    const decoded = jwt.verify(data.token, await sha256(TEST_SECRET_TOKEN));

    expect(decoded).toHaveProperty('userId');
  });

  test('should fail login with invalid password', async () => {
    const response = await login('testowner', 'wrongpassword');

    expect(response.status).toBe(400);

    const data = (await response.json()) as TLoginResponse;

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('password', 'Invalid password');
  });

  test('should login with legacy plaintext password and upgrade hash', async () => {
    await tdb
      .update(users)
      .set({ password: 'password123' })
      .where(eq(users.identity, 'testowner'));

    const response = await login('testowner', 'password123');

    expect(response.status).toBe(200);

    const updatedUser = await tdb
      .select({ password: users.password })
      .from(users)
      .where(eq(users.identity, 'testowner'))
      .get();

    expect(updatedUser).toBeTruthy();
    expect(updatedUser?.password.startsWith('argon2$')).toBe(true);
  });

  test('should login with raw argon2 hash and upgrade to prefixed format', async () => {
    const rawArgon2Hash = await Bun.password.hash('password123', {
      algorithm: 'argon2id'
    });

    await tdb
      .update(users)
      .set({ password: rawArgon2Hash })
      .where(eq(users.identity, 'testowner'));

    const response = await login('testowner', 'password123');

    expect(response.status).toBe(200);

    const updatedUser = await tdb
      .select({ password: users.password })
      .from(users)
      .where(eq(users.identity, 'testowner'))
      .get();

    expect(updatedUser).toBeTruthy();
    expect(updatedUser?.password.startsWith('argon2$')).toBe(true);
  });

  test('should auto-register new user when allowNewUsers is true', async () => {
    const response = await login('newuser', 'newpassword123');

    expect(response.status).toBe(200);

    const data = await response.json();

    expect(data).toHaveProperty('success', true);
    expect(data).toHaveProperty('token');
    expect(data).toHaveProperty('refreshToken');

    const newUser = await tdb
      .select()
      .from(users)
      .where(eq(users.identity, 'newuser'))
      .get();

    expect(newUser).toBeTruthy();
    expect(newUser?.name).toBe('SharkordUser');
  });

  test('should fail when allowNewUsers is false and no invite provided', async () => {
    await tdb.update(settings).set({ allowNewUsers: false });

    const response = await login('anothernewuser', 'password123');

    expect(response.status).toBe(400);

    const data = (await response.json()) as TLoginResponse;

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('identity', 'Invalid invite code');
  });

  test('should allow registration with valid invite when allowNewUsers is false', async () => {
    await tdb.update(settings).set({ allowNewUsers: false });

    await tdb.insert(invites).values({
      code: 'TESTINVITE123',
      creatorId: 1,
      maxUses: 5,
      uses: 0,
      expiresAt: Date.now() + 86400000, // 1 day
      createdAt: Date.now()
    });

    const response = await login('inviteuser', 'password123', 'TESTINVITE123');

    expect(response.status).toBe(200);

    const data = await response.json();

    expect(data).toHaveProperty('success', true);
    expect(data).toHaveProperty('token');
    expect(data).toHaveProperty('refreshToken');

    const updatedInvite = await tdb
      .select()
      .from(invites)
      .where(eq(invites.code, 'TESTINVITE123'))
      .get();

    expect(updatedInvite?.uses).toBe(1);
  });

  test('should fail with expired invite', async () => {
    await tdb.update(settings).set({ allowNewUsers: false });

    await tdb.insert(invites).values({
      code: 'EXPIREDINVITE',
      creatorId: 1,
      maxUses: 5,
      uses: 0,
      expiresAt: Date.now() - 1000, // expired
      createdAt: Date.now() - 86400000
    });

    const response = await login(
      'expiredinviteuser',
      'password123',
      'EXPIREDINVITE'
    );

    expect(response.status).toBe(400);

    const data = (await response.json()) as TLoginResponse;

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('identity');
  });

  test('should fail with maxed out invite', async () => {
    await tdb.update(settings).set({ allowNewUsers: false });

    // Create a maxed out invite
    await tdb.insert(invites).values({
      code: 'MAXEDINVITE',
      creatorId: 1,
      maxUses: 2,
      uses: 2,
      expiresAt: Date.now() + 86400000,
      createdAt: Date.now()
    });

    const response = await login(
      'maxedinviteuser',
      'password123',
      'MAXEDINVITE'
    );

    expect(response.status).toBe(400);

    const data = (await response.json()) as TLoginResponse;

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('identity');
  });

  test('should fail with non-existent invite', async () => {
    await tdb.update(settings).set({ allowNewUsers: false });

    const response = await login(
      'fakeinviteuser',
      'password123',
      'FAKEINVITECODE'
    );

    expect(response.status).toBe(400);

    const data = (await response.json()) as TLoginResponse;

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('identity');
  });

  test('should fail login for banned user', async () => {
    await tdb
      .update(users)
      .set({
        banned: true,
        banReason: 'Test ban reason'
      })
      .where(eq(users.identity, 'testuser'));

    const response = await login('testuser', 'password123');

    expect(response.status).toBe(400);

    const data = (await response.json()) as TLoginResponse;

    expect(data).toHaveProperty('errors');
    expect(data.errors).toHaveProperty('identity');
    expect(data.errors.identity).toContain('banned');
  });

  test('should fail with missing identity', async () => {
    const response = await login('', 'somepassword');

    expect(response.status).toBe(400);

    const data = await response.json();

    expect(data).toHaveProperty('errors');
  });

  test('should fail with missing password', async () => {
    const response = await login('someidentity', '');

    expect(response.status).toBe(400);

    const data = await response.json();

    expect(data).toHaveProperty('errors');
  });

  test('should return valid JWT token with userId claim', async () => {
    const response = await login('testowner', 'password123');

    expect(response.status).toBe(200);

    const data = (await response.json()) as TLoginResponse;

    const decoded = jwt.verify(
      data.token,
      await sha256(TEST_SECRET_TOKEN)
    ) as jwt.JwtPayload;

    expect(decoded).toHaveProperty('userId');
    expect(typeof decoded.userId).toBe('number');
    expect(decoded).toHaveProperty('exp');
    expect(decoded).toHaveProperty('iat');
  });

  test('should assign default role to newly registered user', async () => {
    const response = await login('roleuser', 'password123');

    expect(response.status).toBe(200);

    const newUser = await tdb
      .select()
      .from(users)
      .where(eq(users.identity, 'roleuser'))
      .get();

    expect(newUser).toBeTruthy();

    const userRole = await tdb
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, newUser!.id))
      .get();

    expect(userRole).toBeTruthy();

    const role = await tdb
      .select()
      .from(roles)
      .where(eq(roles.id, userRole!.roleId))
      .get();

    expect(role?.isDefault).toBe(true);
  });

  test('should rotate refresh token and reject reused token', async () => {
    const response = await login('testowner', 'password123');

    expect(response.status).toBe(200);

    const loginData = (await response.json()) as TLoginResponse;
    const firstRefreshToken = loginData.refreshToken;

    const refreshResponse = await refresh(firstRefreshToken);

    expect(refreshResponse.status).toBe(200);

    const refreshData = (await refreshResponse.json()) as TLoginResponse;

    expect(refreshData).toHaveProperty('token');
    expect(refreshData).toHaveProperty('refreshToken');
    expect(refreshData.refreshToken).not.toBe(firstRefreshToken);

    const reusedResponse = await refresh(firstRefreshToken);

    expect(reusedResponse.status).toBe(401);

    const latestRefreshResponse = await refresh(refreshData.refreshToken);

    expect(latestRefreshResponse.status).toBe(200);

    const sessions = await tdb.select().from(refreshTokens);
    const revokedSessions = sessions.filter((session) => !!session.revokedAt);

    expect(revokedSessions.length).toBeGreaterThan(0);
  });

  test('should return 401 for invalid refresh token', async () => {
    const response = await refresh('invalid-refresh-token');

    expect(response.status).toBe(401);

    const data = await response.json();

    expect(data).toHaveProperty('error', 'Invalid refresh token');
  });

  test('should revoke refresh token on logout', async () => {
    const response = await login('testowner', 'password123');

    expect(response.status).toBe(200);

    const loginData = (await response.json()) as TLoginResponse;
    const refreshToken = loginData.refreshToken;

    const logoutResponse = await logout(refreshToken);

    expect(logoutResponse.status).toBe(200);

    const refreshResponse = await refresh(refreshToken);

    expect(refreshResponse.status).toBe(401);
  });

  test('should rate limit excessive login attempts', async () => {
    for (let i = 0; i < 5; i++) {
      const response = await login('testowner', 'wrongpassword');

      expect(response.status).toBe(400);
    }

    const limitedResponse = await login('testowner', 'wrongpassword');

    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get('retry-after')).toBeTruthy();

    const data = await limitedResponse.json();

    expect(data).toHaveProperty(
      'error',
      'Too many login attempts. Please try again shortly.'
    );
  });
});
