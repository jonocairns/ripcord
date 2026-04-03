import { useMemo } from 'react';
import { appLoadingSelector, modViewOpenSelector, modViewUserIdSelector } from './selectors';
import { useAppStore } from './slice';

export const useIsAppLoading = () => useAppStore(appLoadingSelector);

export const useModViewOpen = () => {
	const isOpen = useAppStore(modViewOpenSelector);
	const userId = useAppStore(modViewUserIdSelector);

	return useMemo(() => ({ isOpen, userId }), [isOpen, userId]);
};
