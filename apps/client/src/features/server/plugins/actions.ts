import type { TCommandInfo, TCommandsMapByPlugin } from '@sharkord/shared';
import { useServerStore } from '../slice';

export const setPluginCommands = (commands: TCommandsMapByPlugin) =>
	useServerStore.getState().setPluginCommands(commands);

export const addPluginCommand = (command: TCommandInfo) => useServerStore.getState().addPluginCommand(command);

export const removePluginCommand = (commandName: string) =>
	useServerStore.getState().removePluginCommand({ commandName });
