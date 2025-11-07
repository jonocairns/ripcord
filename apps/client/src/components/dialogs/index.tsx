import { closeDialogs } from '@/features/dialogs/actions';
import { useDialogInfo } from '@/features/dialogs/hooks';
import { createElement, memo } from 'react';
import { ChangeRoleDialog } from './change-role';
import ConfirmActionDialog from './confirm-action';
import { CreateChannelDialog } from './create-channel';
import { CreateInviteDialog } from './create-invite-dialog';
import { Dialog } from './dialogs';
import { ServerPasswordDialog } from './server-password';
import { TextInputDialog } from './text-input';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DialogsMap: any = {
  [Dialog.CONFIRM_ACTION]: ConfirmActionDialog,
  [Dialog.CREATE_CHANNEL]: CreateChannelDialog,
  [Dialog.TEXT_INPUT]: TextInputDialog,
  [Dialog.SERVER_PASSWORD]: ServerPasswordDialog,
  [Dialog.CHANGE_ROLE]: ChangeRoleDialog,
  [Dialog.CREATE_INVITE]: CreateInviteDialog
};

const DialogsProvider = memo(() => {
  const { isOpen, openDialog, props, closing } = useDialogInfo();

  if (!openDialog || !DialogsMap[openDialog]) return null;

  const realIsOpen = isOpen && !closing;

  return createElement(DialogsMap[openDialog], {
    ...props,
    isOpen: realIsOpen,
    close: closeDialogs
  });
});

export { DialogsProvider };
