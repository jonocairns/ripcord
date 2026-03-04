import { useServerStore } from '../slice';
import { categoriesSelector, categoryByIdSelector } from './selectors';

export const useCategories = () => useServerStore(categoriesSelector);

export const useCategoryById = (categoryId: number) =>
  useServerStore((state) => categoryByIdSelector(state, categoryId));
