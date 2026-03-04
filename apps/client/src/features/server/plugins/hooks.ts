import { useServerStore } from '../slice';
import { commandsSelector, flatCommandsSelector } from './selectors';

export const usePluginCommands = () => useServerStore(commandsSelector);

export const useFlatPluginCommands = () => useServerStore(flatCommandsSelector);
