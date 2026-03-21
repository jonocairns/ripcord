import type { TCategory } from '@sharkord/shared';
import type { IServerState } from '../slice';

export const sortCategories = (categories: TCategory[]) => [...categories].sort((a, b) => a.position - b.position);

export const categoriesSelector = (state: IServerState) => state.categories;

export const categoryByIdSelector = (state: IServerState, categoryId: number) =>
	state.categories.find((category) => category.id === categoryId);
