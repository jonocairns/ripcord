import { getTRPCClient } from '@/lib/trpc';
import { Permission, type TPublicServerSettings } from '@sharkord/shared';
import { setPublicServerSettings } from './actions';
import { subscribeToCategories } from './categories/subscriptions';
import { subscribeToChannels } from './channels/subscriptions';
import { subscribeToEmojis } from './emojis/subscriptions';
import { subscribeToMessages } from './messages/subscriptions';
import { subscribeToPlugins } from './plugins/subscriptions';
import { subscribeToRoles } from './roles/subscriptions';
import { subscribeToUsers } from './users/subscriptions';
import { subscribeToVoice } from './voice/subscriptions';
import { rolesSelector } from './roles/selectors';
import { store } from '../store';
import { ownUserSelector } from './users/selectors';

const subscribeToServer = () => {
  const trpc = getTRPCClient();

  const onSettingsUpdateSub = trpc.others.onServerSettingsUpdate.subscribe(
    undefined,
    {
      onData: (settings: TPublicServerSettings) =>
        setPublicServerSettings(settings),
      onError: (err) =>
        console.error('onSettingsUpdate subscription error:', err)
    }
  );

  return () => {
    onSettingsUpdateSub.unsubscribe();
  };
};

const initSubscriptions = () => {
  const state = store.getState();
  const ownUser = ownUserSelector(state);
  const roles = rolesSelector(state);
  const ownRoleIds = new Set(ownUser?.roleIds ?? []);

  const canSubscribeToPluginCommands = roles.some((role) => {
    if (!ownRoleIds.has(role.id)) return false;
    return role.permissions.includes(Permission.EXECUTE_PLUGIN_COMMANDS);
  });

  const subscriptors = [
    subscribeToChannels,
    subscribeToServer,
    subscribeToEmojis,
    subscribeToRoles,
    subscribeToUsers,
    subscribeToMessages,
    subscribeToVoice,
    subscribeToCategories
  ];

  if (canSubscribeToPluginCommands) {
    subscriptors.push(subscribeToPlugins);
  }

  const unsubscribes = subscriptors.map((subscriptor) => subscriptor());

  return () => {
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  };
};

export { initSubscriptions };
