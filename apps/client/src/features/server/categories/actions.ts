import type { TCategory } from '@sharkord/shared';
import { useServerStore } from '../slice';

export const setCategories = (categories: TCategory[]) => {
  useServerStore.getState().setCategories(categories);
};

export const addCategory = (category: TCategory) => {
  useServerStore.getState().addCategory(category);
};

export const updateCategory = (
  categoryId: number,
  category: Partial<TCategory>
) => {
  useServerStore.getState().updateCategory({ categoryId, category });
};

export const removeCategory = (categoryId: number) => {
  useServerStore.getState().removeCategory({ categoryId });
};
