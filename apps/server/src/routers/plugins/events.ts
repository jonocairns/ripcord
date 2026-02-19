import { Permission, ServerEvents } from '@sharkord/shared';
import { protectedProcedure } from '../../utils/trpc';

const onPluginLogRoute = protectedProcedure.subscription(async ({ ctx }) => {
  await ctx.needsPermission(Permission.MANAGE_PLUGINS);
  return ctx.pubsub.subscribe(ServerEvents.PLUGIN_LOG);
});

const onCommandsChangeRoute = protectedProcedure.subscription(
  async ({ ctx }) => {
    await ctx.needsPermission(Permission.EXECUTE_PLUGIN_COMMANDS);
    return ctx.pubsub.subscribe(ServerEvents.PLUGIN_COMMANDS_CHANGE);
  }
);

export { onCommandsChangeRoute, onPluginLogRoute };
