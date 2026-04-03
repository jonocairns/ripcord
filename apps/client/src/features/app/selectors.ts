import type { TAppState } from './slice';

export const appLoadingSelector = (state: TAppState) => state.loading;

export const modViewOpenSelector = (state: TAppState) => state.modViewOpen;

export const modViewUserIdSelector = (state: TAppState) => state.modViewUserId;
