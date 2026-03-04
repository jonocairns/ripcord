import type { ServerScreen } from '@/components/server-screens/screens';
import type { TGenericObject } from '@sharkord/shared';
import { create } from 'zustand';

type TServerScreenState = {
  openServerScreen: ServerScreen | undefined;
  props?: TGenericObject;
  isOpen: boolean;
};

const getInitialState = (): TServerScreenState => ({
  openServerScreen: undefined,
  props: {},
  isOpen: false
});

export const useServerScreensStore = create<TServerScreenState>(() =>
  getInitialState()
);

export { getInitialState as getInitialServerScreenState };
