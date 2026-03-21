import { useMemo } from 'react';
import { useServerStore } from '../slice';
import { commandsSelector, toFlatCommands } from './selectors';

export const usePluginCommands = () => useServerStore(commandsSelector);

export const useFlatPluginCommands = () => {
	const pluginCommands = useServerStore(commandsSelector);

	return useMemo(() => toFlatCommands(pluginCommands), [pluginCommands]);
};
