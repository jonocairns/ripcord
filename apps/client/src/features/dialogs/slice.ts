import type { Dialog } from '@/components/dialogs/dialogs';
import type { TGenericObject } from '@sharkord/shared';
import { create } from 'zustand';

export type TDialogState = {
  openDialog: Dialog | undefined;
  props: TGenericObject;
  isOpen: boolean;
  closing: boolean;
};

const getInitialState = (): TDialogState => ({
  openDialog: undefined,
  props: {},
  isOpen: false,
  closing: false
});

export const useDialogStore = create<TDialogState>(() => getInitialState());

export { getInitialState as getInitialDialogState };
