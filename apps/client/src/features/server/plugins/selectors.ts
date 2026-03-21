import type { TCommandInfo } from '@sharkord/shared';
import type { IServerState } from '../slice';

export const commandsSelector = (state: IServerState) => state.pluginCommands;

export const toFlatCommands = (pluginCommands: IServerState['pluginCommands']): TCommandInfo[] =>
	Object.values(pluginCommands).flat();
