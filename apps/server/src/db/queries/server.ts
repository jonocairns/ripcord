import type { TJoinedSettings, TPublicServerSettings } from '@sharkord/shared';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '..';
import { files, settings } from '../schema';

// since this is static, we can keep it in memory to avoid querying the DB every time
let authToken: string;

const getSettings = async (): Promise<TJoinedSettings> => {
  const serverSettings = await db.select().from(settings).get()!;

  const logo = serverSettings.logoId
    ? await db
        .select()
        .from(files)
        .where(eq(files.id, serverSettings.logoId))
        .get()
    : undefined;

  return {
    ...serverSettings,
    logo: logo ?? null
  };
};

const getPublicSettings: () => Promise<TPublicServerSettings> = async () => {
  const settings = await getSettings();

  const publicSettings: TPublicServerSettings = {
    description: settings.description ?? '',
    name: settings.name,
    serverId: settings.serverId,
    storageUploadEnabled: settings.storageUploadEnabled,
    storageQuota: settings.storageQuota,
    storageUploadMaxFileSize: settings.storageUploadMaxFileSize,
    storageSpaceQuotaByUser: settings.storageSpaceQuotaByUser,
    storageOverflowAction: settings.storageOverflowAction,
    enablePlugins: settings.enablePlugins
  };

  return publicSettings;
};

type TRedactedSettings = Omit<TJoinedSettings, 'authTokenSecret' | 'secretToken'>;

const redactSettings = (serverSettings: TJoinedSettings): TRedactedSettings => {
  const {
    authTokenSecret: _authTokenSecret,
    secretToken: _secretToken,
    ...safeSettings
  } = serverSettings;

  return safeSettings;
};

const getServerTokenSync = (): string => {
  if (!authToken) {
    throw new Error('Server auth token has not been initialized yet');
  }

  return authToken;
};

const getServerToken = async (): Promise<string> => {
  if (authToken) return authToken;

  const serverSettings = await db
    .select({ authTokenSecret: settings.authTokenSecret })
    .from(settings)
    .get();

  if (!serverSettings) {
    throw new Error('Server settings not found');
  }

  if (!serverSettings.authTokenSecret) {
    const generatedAuthToken = `${Bun.randomUUIDv7()}.${Bun.randomUUIDv7()}`;

    await db
      .update(settings)
      .set({ authTokenSecret: generatedAuthToken })
      .where(isNotNull(settings.serverId))
      .run();

    authToken = generatedAuthToken;
    return authToken;
  }

  authToken = serverSettings.authTokenSecret;

  return authToken;
};

export {
  getPublicSettings,
  getServerToken,
  getServerTokenSync,
  getSettings,
  redactSettings
};
