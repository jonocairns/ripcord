import { Dialog } from '@/components/dialogs/dialogs';
import {
  ScreenAudioMode,
  type TDesktopCapabilities,
  type TDesktopScreenShareSelection,
  type TDesktopShareSource
} from '@/runtime/types';
import type { TGenericObject } from '@sharkord/shared';
import { getInitialDialogState, useDialogStore } from './slice';

export const openDialog = (dialog: Dialog, props?: TGenericObject) => {
  useDialogStore.setState({
    openDialog: dialog,
    props: props || {},
    isOpen: true
  });
};

export const closeDialogs = () => {
  useDialogStore.setState({ closing: true });

  // allow fade out animation to complete before stopping rendering, otherwise it looks choppy
  setTimeout(() => {
    useDialogStore.setState(getInitialDialogState());

    setTimeout(() => {
      // https://github.com/radix-ui/primitives/issues/1241
      // remove this after radix fixes the bug
      document.body.style.pointerEvents = '';
    }, 0);
  }, 150);
};

export const requestConfirmation = async ({
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'info',
  onConfirm,
  onCancel
}: {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'info';
  onConfirm?: () => void;
  onCancel?: () => void;
}): Promise<boolean> => {
  return new Promise((resolve) => {
    openDialog(Dialog.CONFIRM_ACTION, {
      title,
      message,
      confirmLabel,
      cancelLabel,
      variant,
      onConfirm: () => {
        onConfirm?.();
        closeDialogs();
        resolve(true);
      },
      onCancel: () => {
        onCancel?.();
        closeDialogs();
        resolve(false);
      }
    });
  });
};

export const requestTextInput = async ({
  title,
  message,
  confirmLabel,
  cancelLabel,
  type = 'text',
  allowEmpty = false,
  autoClose = true
}: {
  title?: string;
  message?: string;
  type?: 'text' | 'password';
  confirmLabel?: string;
  cancelLabel?: string;
  allowEmpty?: boolean;
  autoClose?: boolean;
}): Promise<string | undefined | null> => {
  return new Promise((resolve) => {
    openDialog(Dialog.TEXT_INPUT, {
      title,
      message,
      confirmLabel,
      cancelLabel,
      allowEmpty,
      type,
      onConfirm: (text: string) => {
        if (autoClose) {
          closeDialogs();
        }

        resolve(text);
      },
      onCancel: () => {
        resolve(null);
      }
    });
  });
};

export const resetDialogs = () => {
  useDialogStore.setState(getInitialDialogState());
};

export const requestScreenShareSelection = async ({
  sources,
  capabilities,
  defaultAudioMode
}: {
  sources: TDesktopShareSource[];
  capabilities: TDesktopCapabilities;
  defaultAudioMode: ScreenAudioMode;
}): Promise<TDesktopScreenShareSelection | null> => {
  return new Promise((resolve) => {
    openDialog(Dialog.SCREEN_SHARE_PICKER, {
      sources,
      capabilities,
      defaultAudioMode,
      onConfirm: (selection: TDesktopScreenShareSelection) => {
        closeDialogs();
        resolve(selection);
      },
      onCancel: () => {
        closeDialogs();
        resolve(null);
      }
    });
  });
};
