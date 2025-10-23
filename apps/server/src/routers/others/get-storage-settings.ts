import { Permission, type TStorageSettings } from '@sharkord/shared';
import { getSettings } from '../../db/queries/others/get-settings';
import { getDiskMetrics } from '../../utils/metrics';
import { protectedProcedure } from '../../utils/trpc';

const getStorageSettingsRoute = protectedProcedure.query(async ({ ctx }) => {
  await ctx.needsPermission(Permission.MANAGE_STORAGE);

  const [settings, diskMetrics] = await Promise.all([
    getSettings(),
    getDiskMetrics()
  ]);

  const storageSettings: TStorageSettings = {
    storageUploadEnabled: settings.storageUploadEnabled,
    storageUploadMaxFileSize: settings.storageUploadMaxFileSize,
    storageUploadMaxFileCount: settings.storageUploadMaxFileCount,
    storageSpaceQuotaByUser: settings.storageSpaceQuotaByUser,
    storageOverflowAction: settings.storageOverflowAction
  };

  return { storageSettings, diskMetrics };
});

export { getStorageSettingsRoute };
