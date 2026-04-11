import {
  ChannelPermission,
  Permission,
  type TJoinedRole
} from '@sharkord/shared';
import { afterEach, describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';
import { VoiceRuntime } from '../../runtimes/voice';

const VOICE_CHANNEL_ID = 2;

const ensureVoiceRuntime = async (): Promise<VoiceRuntime> => {
  const existingRuntime = VoiceRuntime.findById(VOICE_CHANNEL_ID);

  if (existingRuntime) {
    return existingRuntime;
  }

  const runtime = new VoiceRuntime(VOICE_CHANNEL_ID);
  await runtime.init();

  return runtime;
};

const getDefaultRole = (roles: TJoinedRole[]): TJoinedRole => {
  const defaultRole = roles.find((role) => role.isDefault);

  if (!defaultRole) {
    throw new Error('Default role not found');
  }

  return defaultRole;
};

afterEach(async () => {
  const runtime = VoiceRuntime.findById(VOICE_CHANNEL_ID);

  if (!runtime) {
    return;
  }

  [...runtime.getState().users].forEach((user) => {
    runtime.removeUser(user.userId);
  });

  await runtime.destroy();
});

describe('voice permission revalidation', () => {
  test('evicts active voice users when a role loses JOIN_VOICE_CHANNELS', async () => {
    const runtime = await ensureVoiceRuntime();
    const { caller: ownerCaller, initialData } = await initTest(1);
    const { caller: userCaller } = await initTest(2);
    const defaultRole = getDefaultRole(initialData.roles);

    await userCaller.voice.join({
      channelId: VOICE_CHANNEL_ID,
      state: {
        micMuted: false,
        soundMuted: false
      }
    });

    expect(runtime.getUser(2)).toBeDefined();

    await ownerCaller.roles.update({
      roleId: defaultRole.id,
      name: defaultRole.name,
      color: defaultRole.color,
      permissions: defaultRole.permissions.filter(
        (permission) => permission !== Permission.JOIN_VOICE_CHANNELS
      )
    });

    expect(runtime.getUser(2)).toBeUndefined();

    await expect(userCaller.voice.createProducerTransport()).rejects.toThrow(
      'Insufficient permissions'
    );
  });

  test('evicts active voice users when private-channel access is revoked', async () => {
    const runtime = await ensureVoiceRuntime();
    const { caller: ownerCaller } = await initTest(1);
    const { caller: userCaller } = await initTest(2);

    await ownerCaller.channels.updatePermissions({
      channelId: VOICE_CHANNEL_ID,
      userId: 2,
      permissions: [
        ChannelPermission.VIEW_CHANNEL,
        ChannelPermission.JOIN,
        ChannelPermission.SPEAK
      ]
    });

    await ownerCaller.channels.update({
      channelId: VOICE_CHANNEL_ID,
      private: true
    });

    await userCaller.voice.join({
      channelId: VOICE_CHANNEL_ID,
      state: {
        micMuted: false,
        soundMuted: false
      }
    });

    expect(runtime.getUser(2)).toBeDefined();

    await ownerCaller.channels.deletePermissions({
      channelId: VOICE_CHANNEL_ID,
      userId: 2
    });

    expect(runtime.getUser(2)).toBeUndefined();

    await expect(userCaller.voice.createProducerTransport()).rejects.toThrow(
      'User is not in a voice channel'
    );
  });
});
