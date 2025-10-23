import { StorageOverflowAction } from '@sharkord/shared';
import { z } from 'zod';
import { updateSettings as updateSettingsMutation } from '../../db/mutations/server/update-server-settings';
import { publishSettings } from '../../db/publishers';
import { protectedProcedure } from '../../utils/trpc';

const updateSettingsRoute = protectedProcedure
  .input(
    z.object({
      name: z.string().min(2).max(24).optional(),
      description: z.string().max(128).optional(),
      password: z.string().min(1).max(32).optional(),
      allowNewUsers: z.boolean().optional(),
      storageUploadEnabled: z.boolean().optional(),
      storageUploadMaxFileSize: z.number().min(0).optional(),
      storageUploadMaxFileCount: z.number().min(0).optional(),
      storageSpaceQuotaByUser: z.number().min(0).optional(),
      storageOverflowAction: z.enum(StorageOverflowAction).optional()
    })
  )
  .mutation(async ({ input }) => {
    await updateSettingsMutation({
      name: input.name,
      description: input.description,
      password: input.password,
      allowNewUsers: input.allowNewUsers,
      storageUploadEnabled: input.storageUploadEnabled,
      storageUploadMaxFileSize: input.storageUploadMaxFileSize,
      storageUploadMaxFileCount: input.storageUploadMaxFileCount,
      storageSpaceQuotaByUser: input.storageSpaceQuotaByUser,
      storageOverflowAction: input.storageOverflowAction
    });

    await publishSettings();
  });

export { updateSettingsRoute };
