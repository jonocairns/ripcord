import { sha256, type TTempFile } from '@sharkord/shared';
import { describe, expect, test } from 'bun:test';
import {
  getCaller,
  initTest,
  login,
  uploadFile
} from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { TEST_SECRET_TOKEN } from '../../__tests__/seed';
import { settings, userRoles, users } from '../../db/schema';

describe('others router', () => {
  test('should throw when user tries to join with no handshake', async () => {
    const { caller } = await getCaller(1);

    await expect(
      caller.others.joinServer({
        handshakeHash: ''
      })
    ).rejects.toThrow('Invalid handshake hash');
  });

  test('should allow user to join with valid handshake', async () => {
    const joiningUserId = 1;

    const { caller } = await getCaller(joiningUserId);
    const { handshakeHash } = await caller.others.handshake();

    const result = await caller.others.joinServer({
      handshakeHash
    });

    expect(result).toHaveProperty('categories');
    expect(result).toHaveProperty('channels');
    expect(result).toHaveProperty('users');
    expect(result).toHaveProperty('serverId');
    expect(result).toHaveProperty('serverName');
    expect(result).toHaveProperty('ownUserId');
    expect(result).toHaveProperty('voiceMap');
    expect(result).toHaveProperty('roles');
    expect(result).toHaveProperty('emojis');
    expect(result).toHaveProperty('channelPermissions');

    expect(result.ownUserId).toBe(joiningUserId);

    for (const user of result.users) {
      expect(user._identity).toBeUndefined();
    }
  });

  test('should ask for password if server has one set', async () => {
    const { caller } = await initTest(1);
    const { hasPassword } = await caller.others.handshake();

    expect(hasPassword).toBe(false);

    await caller.others.updateSettings({
      password: 'testpassword'
    });

    const { hasPassword: hasPasswordAfter } = await caller.others.handshake();

    expect(hasPasswordAfter).toBe(true);

    const row = await tdb
      .select({ password: settings.password })
      .from(settings)
      .get();

    expect(row?.password?.startsWith('argon2$')).toBe(true);
  });

  test('should redact sensitive settings fields', async () => {
    const { caller } = await initTest(1);

    await caller.others.updateSettings({
      password: 'testpassword'
    });

    const currentSettings = await caller.others.getSettings();

    expect(currentSettings.password).toBe('');
    expect(currentSettings.secretToken).toBeNull();
    expect(currentSettings.authToken).toBeNull();
  });

  test('should verify and upgrade legacy server password on join', async () => {
    await tdb.update(settings).set({ password: 'legacy-server-pass' }).execute();

    const { caller } = await getCaller(1);
    const { handshakeHash } = await caller.others.handshake();

    await caller.others.joinServer({
      handshakeHash,
      password: 'legacy-server-pass'
    });

    const updated = await tdb
      .select({ password: settings.password })
      .from(settings)
      .get();

    expect(updated?.password).not.toBe('legacy-server-pass');
    expect(updated?.password?.startsWith('argon2$')).toBe(true);
  });

  test('should update server settings', async () => {
    const { caller } = await initTest(1);

    const newSettings = {
      name: 'Updated Test Server',
      description: 'An updated description',
      allowNewUsers: false,
      storageUploadEnabled: false
    };

    await caller.others.updateSettings(newSettings);

    const settings = await caller.others.getSettings();

    expect(settings.name).toBe(newSettings.name);
    expect(settings.description).toBe(newSettings.description);
    expect(settings.allowNewUsers).toBe(newSettings.allowNewUsers);
    expect(settings.storageUploadEnabled).toBe(
      newSettings.storageUploadEnabled
    );
  });

  test('should throw when using invalid secret token', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.others.useSecretToken({ token: 'invalid-token' })
    ).rejects.toThrow('Invalid secret token');
  });

  test('should accept valid secret token and assign owner role', async () => {
    const { caller } = await initTest(2);

    await caller.others.useSecretToken({ token: TEST_SECRET_TOKEN });

    const allUsers = await caller.users.getAll();
    const updatedUser = allUsers.find((u) => u.id === 2);

    expect(updatedUser).toBeDefined();
    expect(updatedUser?.roleIds).toContain(1);
  });

  test('should disable open registration after secret token is used', async () => {
    const { caller } = await initTest(2);

    await caller.others.useSecretToken({ token: TEST_SECRET_TOKEN });

    const updatedSettings = await tdb
      .select({ allowNewUsers: settings.allowNewUsers })
      .from(settings)
      .get();

    expect(updatedSettings?.allowNewUsers).toBe(false);
  });

  test('should reject secret token reuse after bootstrap ownership is claimed', async () => {
    const { caller: caller2 } = await initTest(2);

    const now = Date.now();
    const insertedUser = await tdb
      .insert(users)
      .values({
        name: 'Bootstrap Candidate',
        identity: 'bootstrap-candidate',
        password: await sha256('password123'),
        avatarId: null,
        bannerId: null,
        bio: null,
        bannerColor: null,
        createdAt: now
      })
      .returning({ id: users.id })
      .get();

    await tdb.insert(userRoles).values({
      userId: insertedUser!.id,
      roleId: 2,
      createdAt: now
    });

    const { caller: caller3 } = await initTest(insertedUser!.id);

    await caller2.others.useSecretToken({ token: TEST_SECRET_TOKEN });

    await expect(
      caller3.others.useSecretToken({ token: TEST_SECRET_TOKEN })
    ).rejects.toThrow('Bootstrap token is no longer available');
  });

  test('should change logo', async () => {
    const { caller } = await initTest(1);

    const response = await login('testowner', 'password123');
    const { token } = (await response.json()) as { token: string };

    const logoFile = new File(['logo content'], 'logo.png', {
      type: 'image/png'
    });

    const uploadResponse = await uploadFile(logoFile, token);
    const tempFile = (await uploadResponse.json()) as TTempFile;

    expect(tempFile).toBeDefined();
    expect(tempFile.id).toBeDefined();

    const settingsBefore = await caller.others.getSettings();

    expect(settingsBefore.logo).toBeNull();

    await caller.others.changeLogo({ fileId: tempFile.id });

    const settingsAfter = await caller.others.getSettings();

    expect(settingsAfter.logo).toBeDefined();
    expect(settingsAfter.logo?.originalName).toBe(logoFile.name);

    await caller.others.changeLogo({});

    const settingsAfterRemoval = await caller.others.getSettings();

    expect(settingsAfterRemoval.logo).toBeNull();
  });

  test('should rate limit excessive join attempts', async () => {
    const { caller } = await getCaller(1);

    for (let i = 0; i < 5; i++) {
      await expect(
        caller.others.joinServer({
          handshakeHash: ''
        })
      ).rejects.toThrow('Invalid handshake hash');
    }

    await expect(
      caller.others.joinServer({
        handshakeHash: ''
      })
    ).rejects.toThrow('Too many requests. Please try again shortly.');
  });
});
