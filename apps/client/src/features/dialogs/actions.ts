import type { TGenericObject } from '@sharkord/shared';
import { toast } from 'sonner';
import { Dialog } from '@/components/dialogs/dialogs';
import type {
	ScreenAudioMode,
	TDesktopCapabilities,
	TDesktopScreenShareSelection,
	TDesktopShareSource,
	TDesktopShareSourceThumbnail,
} from '@/runtime/types';
import { getInitialDialogState, useDialogStore } from './slice';

export const openDialog = (dialog: Dialog, props?: TGenericObject) => {
	useDialogStore.setState({
		openDialog: dialog,
		props: props || {},
		isOpen: true,
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
	onCancel,
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
			},
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
	autoClose = true,
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
			},
		});
	});
};

export const resetDialogs = () => {
	useDialogStore.setState(getInitialDialogState());
};

export const requestScreenShareSelection = async ({
	defaultAudioMode,
	loadData,
	loadThumbnails,
}: {
	defaultAudioMode: ScreenAudioMode;
	loadData: () => Promise<{
		sources: TDesktopShareSource[];
		capabilities: TDesktopCapabilities;
	}>;
	// Phase 2: thumbnails captured separately and merged into the rendered list
	// by id. Absent off-desktop or on bridges without the method.
	loadThumbnails?: () => Promise<TDesktopShareSourceThumbnail[]>;
}): Promise<TDesktopScreenShareSelection | null> => {
	let settled = false;
	let resolveSelection!: (value: TDesktopScreenShareSelection | null) => void;
	const selectionPromise = new Promise<TDesktopScreenShareSelection | null>((resolve) => {
		resolveSelection = resolve;
	});

	const resolveOnce = (value: TDesktopScreenShareSelection | null) => {
		if (settled) return;
		settled = true;
		closeDialogs();
		resolveSelection(value);
	};

	openDialog(Dialog.SCREEN_SHARE_PICKER, {
		sources: [],
		capabilities: undefined,
		isLoading: true,
		isLoadingThumbnails: true,
		defaultAudioMode,
		onConfirm: (selection: TDesktopScreenShareSelection) => resolveOnce(selection),
		onCancel: () => resolveOnce(null),
	});

	try {
		const data = await loadData();

		if (settled) return selectionPromise;

		const state = useDialogStore.getState();
		const dialogStillOpen = state.openDialog === Dialog.SCREEN_SHARE_PICKER && state.isOpen;
		if (!dialogStillOpen) return selectionPromise;

		if (data.sources.length === 0) {
			toast.error('No windows or screens were detected for sharing.');
			resolveOnce(null);
			return selectionPromise;
		}

		useDialogStore.setState({
			props: {
				...state.props,
				sources: data.sources,
				capabilities: data.capabilities,
				isLoading: false,
			},
		});

		// Phase 2: stream thumbnails in (off the critical path) and merge them
		// into the already-rendered list by id. Thumbnails are an enhancement, so
		// any failure just clears the loading state without disrupting selection.
		void (async () => {
			const finishThumbnailLoading = () => {
				const current = useDialogStore.getState();
				if (current.openDialog !== Dialog.SCREEN_SHARE_PICKER || !current.isOpen) {
					return;
				}

				useDialogStore.setState({ props: { ...current.props, isLoadingThumbnails: false } });
			};

			if (!loadThumbnails) {
				finishThumbnailLoading();
				return;
			}

			try {
				const thumbnails = await loadThumbnails();
				const thumbnailById = new Map(thumbnails.map((thumbnail) => [thumbnail.id, thumbnail]));
				const current = useDialogStore.getState();
				if (settled || current.openDialog !== Dialog.SCREEN_SHARE_PICKER || !current.isOpen) {
					return;
				}

				const currentSources = (current.props.sources ?? []) as TDesktopShareSource[];
				const mergedSources = currentSources.map((source) => {
					const thumbnail = thumbnailById.get(source.id);
					if (!thumbnail) {
						// No thumbnail came back for this source (e.g. it closed, or the GPU
						// couldn't capture it) — now that phase 2 is done, mark it unavailable.
						return { ...source, previewAvailable: false };
					}

					return {
						...source,
						previewAvailable: thumbnail.previewAvailable,
						thumbnailDataUrl: thumbnail.thumbnailDataUrl,
					};
				});

				useDialogStore.setState({
					props: { ...current.props, sources: mergedSources, isLoadingThumbnails: false },
				});
			} catch {
				finishThumbnailLoading();
			}
		})();
	} catch {
		if (!settled) {
			toast.error('Failed to load shareable sources.');
			resolveOnce(null);
		}
	}

	return selectionPromise;
};
