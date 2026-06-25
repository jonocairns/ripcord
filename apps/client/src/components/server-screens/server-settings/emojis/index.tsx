import { memo, useCallback } from 'react';
import { Dialog } from '@/components/dialogs/dialogs';
import { LoadingCard } from '@/components/ui/loading-card';
import { openDialog } from '@/features/dialogs/actions';
import { useAdminEmojis } from '@/features/server/admin/hooks';
import { useFilePicker } from '@/hooks/use-file-picker';
import { EmojiList } from './emoji-list';

const Emojis = memo(() => {
	const { emojis, refetch, loading } = useAdminEmojis();
	const openFilePicker = useFilePicker();

	const uploadEmoji = useCallback(async () => {
		const files = await openFilePicker('image/*', true);

		if (!files || files.length === 0) return;

		openDialog(Dialog.CREATE_EMOJI, { files, refetch });
	}, [openFilePicker, refetch]);

	if (loading) {
		return <LoadingCard className="h-[600px]" />;
	}

	return (
		<div className="space-y-4">
			<EmojiList emojis={emojis} uploadEmoji={uploadEmoji} refetch={refetch} />
		</div>
	);
});

export { Emojis };
