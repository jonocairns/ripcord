import type { TCategory } from '@sharkord/shared';
import type { IServerState } from '../slice';

let lastCategoriesInput: IServerState['categories'] | undefined;
let lastCategories: TCategory[] = [];

export const categoriesSelector = (state: IServerState) => {
  if (state.categories === lastCategoriesInput) {
    return lastCategories;
  }

  lastCategoriesInput = state.categories;
  lastCategories = [...state.categories].sort((a, b) => a.position - b.position);

  return lastCategories;
};

export const categoryByIdSelector = (
  state: IServerState,
  categoryId: number
) => categoriesSelector(state).find((category) => category.id === categoryId);
