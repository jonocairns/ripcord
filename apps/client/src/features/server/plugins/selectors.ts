import type { TCommandInfo } from '@sharkord/shared';
import type { IServerState } from '../slice';

let lastCommandsInput: IServerState['pluginCommands'] | undefined;
let lastFlatCommands: TCommandInfo[] = [];

export const commandsSelector = (state: IServerState) => state.pluginCommands;

export const flatCommandsSelector = (state: IServerState) => {
  if (state.pluginCommands === lastCommandsInput) {
    return lastFlatCommands;
  }

  lastCommandsInput = state.pluginCommands;
  lastFlatCommands = Object.values(state.pluginCommands).flat();

  return lastFlatCommands;
};
