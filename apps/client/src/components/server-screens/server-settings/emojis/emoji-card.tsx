import { EMOJI_NAME_MAX, emojiNameSchema, type TJoinedEmoji, toEmojiNameChars } from '@sharkord/shared';
import { Pencil, Trash2 } from 'lucide-react';
import { memo, useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { UserAvatar } from '@/components/user-avatar';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getFileUrl } from '@/helpers/get-file-url';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';

type TEmojiCardProps = {
	emoji: TJoinedEmoji;
	refetch: () => void;
};

const EmojiCard = memo(({ emoji, refetch }: TEmojiCardProps) => {
	const [isEditing, setIsEditing] = useState(false);
	const [name, setName] = useState(emoji.name);
	const [isSaving, setIsSaving] = useState(false);
	const cancelledRef = useRef(false);

	const startEditing = useCallback(() => {
		setName(emoji.name);
		setIsEditing(true);
	}, [emoji.name]);

	const cancelEditing = useCallback(() => {
		cancelledRef.current = true;
		setName(emoji.name);
		setIsEditing(false);
	}, [emoji.name]);

	const commit = useCallback(async () => {
		// Escape sets cancelledRef then blurs; ignore the save the blur triggers.
		if (cancelledRef.current) {
			cancelledRef.current = false;
			return;
		}

		setIsEditing(false);

		if (name === emoji.name) return;

		const result = emojiNameSchema.safeParse(name);

		if (!result.success) {
			toast.error(result.error.issues[0]?.message ?? 'Invalid emoji name');
			setName(emoji.name);
			return;
		}

		setIsSaving(true);

		const trpc = getTRPCClient();

		try {
			await trpc.emojis.update.mutate({ emojiId: emoji.id, name });
			refetch();
			toast.success('Emoji renamed');
		} catch (err) {
			setName(emoji.name);
			toast.error(getTrpcError(err, 'Failed to rename emoji'));
		} finally {
			setIsSaving(false);
		}
	}, [name, emoji.id, emoji.name, refetch]);

	const handleDelete = useCallback(async () => {
		const answer = await requestConfirmation({
			title: 'Delete Emoji',
			message: `Are you sure you want to delete :${emoji.name}:? This action cannot be undone.`,
			confirmLabel: 'Delete',
			variant: 'danger',
		});

		if (!answer) return;

		const trpc = getTRPCClient();

		try {
			await trpc.emojis.delete.mutate({ emojiId: emoji.id });
			refetch();
			toast.success('Emoji deleted');
		} catch (error) {
			toast.error(getTrpcError(error, 'Failed to delete emoji'));
		}
	}, [emoji.id, emoji.name, refetch]);

	return (
		<div className="group relative flex flex-col items-center gap-1.5 rounded-lg border bg-card p-2.5 transition-colors hover:bg-muted/40">
			<Tooltip content={`Uploaded by ${emoji.user.name}`}>
				<div className="absolute left-1.5 top-1.5 cursor-pointer opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
					<UserAvatar userId={emoji.user.id} className="h-5 w-5" fallbackClassName="text-[9px]" showUserPopover />
				</div>
			</Tooltip>

			<Button
				size="icon"
				variant="ghost"
				className="absolute right-1 top-1 h-6 w-6 text-muted-foreground/70 opacity-0 transition hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
				onClick={handleDelete}
				title="Delete emoji"
				aria-label={`Delete ${emoji.name}`}
			>
				<Trash2 className="h-3.5 w-3.5" />
			</Button>

			<div className="mt-2.5 flex h-11 w-11 items-center justify-center rounded-md bg-muted/30">
				<img src={getFileUrl(emoji.file)} alt={emoji.name} className="max-h-9 max-w-9 object-contain" loading="lazy" />
			</div>

			{isEditing ? (
				<input
					// biome-ignore lint/a11y/noAutofocus: focus the field the user just opened for editing
					autoFocus
					value={name}
					onChange={(e) => setName(toEmojiNameChars(e.target.value))}
					onBlur={commit}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.currentTarget.blur();
						} else if (e.key === 'Escape') {
							cancelEditing();
						}
					}}
					disabled={isSaving}
					maxLength={EMOJI_NAME_MAX}
					aria-label={`Rename ${emoji.name}`}
					className="w-full rounded-md border border-input bg-background px-2 py-1 text-center font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
				/>
			) : (
				<button
					type="button"
					onClick={startEditing}
					disabled={isSaving}
					title="Click to rename"
					className="flex w-full items-center justify-center gap-1 rounded px-1 py-1 font-mono text-xs transition-colors hover:bg-muted/60"
				>
					<span className="truncate">
						<span className="text-muted-foreground">:</span>
						{emoji.name}
						<span className="text-muted-foreground">:</span>
					</span>
					<Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-70" />
				</button>
			)}
		</div>
	);
});

export { EmojiCard };
