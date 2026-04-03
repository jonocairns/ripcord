import type { TCommandsMapByPlugin } from '@sharkord/shared';
import { useServerStore } from '../slice';

export const setPluginCommands = (commands: TCommandsMapByPlugin) =>
	useServerStore.getState().setPluginCommands(commands);
