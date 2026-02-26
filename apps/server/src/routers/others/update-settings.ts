import {
  ActivityLogType,
  Permission,
  StorageOverflowAction
} from '@sharkord/shared';
import { z } from 'zod';
import { updateSettings } from '../../db/mutations/server';
import { publishSettings } from '../../db/publishers';
import { getSettings } from '../../db/queries/server';
import { hashPassword } from '../../helpers/password';
import { pluginManager } from '../../plugins';
import { enqueueActivityLog } from '../../queues/activity-log';
import { protectedProcedure } from '../../utils/trpc';

const updateSettingsRoute = protectedProcedure
  .input(
    z.object({
      name: z.string().min(2).max(24).optional(),
      description: z.string().max(128).optional(),
      password: z.string().max(32).optional().nullable(),
      allowNewUsers: z.boolean().optional(),
      storageUploadEnabled: z.boolean().optional(),
      storageUploadMaxFileSize: z.number().min(0).optional(),
      storageSpaceQuotaByUser: z.number().min(0).optional(),
      storageOverflowAction: z.enum(StorageOverflowAction).optional(),
      enablePlugins: z.boolean().optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_SETTINGS);
    const nextPasswordInput =
      input.password === undefined
        ? undefined
        : input.password
          ? input.password
          : null;
    const nextPassword =
      typeof nextPasswordInput === 'string'
        ? await hashPassword(nextPasswordInput)
        : nextPasswordInput;

    const { enablePlugins: oldEnablePlugins } = await getSettings();

    await updateSettings({
      name: input.name,
      description: input.description,
      password: nextPassword,
      allowNewUsers: input.allowNewUsers,
      storageUploadEnabled: input.storageUploadEnabled,
      storageUploadMaxFileSize: input.storageUploadMaxFileSize,
      storageSpaceQuotaByUser: input.storageSpaceQuotaByUser,
      storageOverflowAction: input.storageOverflowAction,
      enablePlugins: input.enablePlugins
    });

    if (oldEnablePlugins !== input.enablePlugins) {
      if (input.enablePlugins) {
        await pluginManager.loadPlugins();
      } else {
        await pluginManager.unloadPlugins();
      }
    }

    publishSettings();

    enqueueActivityLog({
      type: ActivityLogType.EDIT_SERVER_SETTINGS,
      userId: ctx.userId,
      details: {
        values: {
          ...input,
          password: input.password !== undefined ? '***redacted***' : undefined
        }
      }
    });
  });

export { updateSettingsRoute };
