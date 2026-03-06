import { dialogInfoSelector } from './selectors';
import { useDialogStore } from './slice';

export const useDialogInfo = () => useDialogStore(dialogInfoSelector);
