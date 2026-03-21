import { useMemo } from 'react';
import { useServerStore } from '../slice';
import { categoriesSelector, categoryByIdSelector, sortCategories } from './selectors';

export const useCategories = () => {
	const categories = useServerStore(categoriesSelector);

	return useMemo(() => sortCategories(categories), [categories]);
};

export const useCategoryById = (categoryId: number) =>
	useServerStore((state) => categoryByIdSelector(state, categoryId));
