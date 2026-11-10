import { isEmptyMessage, type TMessage } from '@sharkord/shared';
import { memo, useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { TiptapInput } from '@/components/tiptap-input';
import { AutoFocus } from '@/components/ui/auto-focus';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';

type TMessageEditInlineProps = {
	message: TMessage;
	onBlur: () => void;
};

const MessageEditInline = memo(({ message, onBlur }: TMessageEditInlineProps) => {
	const [value, setValue] = useState<string>(message.content ?? '');
	// The editor stays open after a rejected save, so ignore Enter while a save is in flight.
	const savingRef = useRef(false);

	const onSubmit = useCallback(
		async (newValue: string) => {
			if (isEmptyMessage(newValue)) {
				toast.error('Message cannot be empty');
				onBlur();
				return;
			}

			if (savingRef.current) return;
			savingRef.current = true;

			const trpc = getTRPCClient();

			try {
				await trpc.messages.edit.mutate({
					messageId: message.id,
					content: newValue,
				});
				toast.success('Message edited');
				onBlur();
			} catch (error) {
				toast.error(getTrpcError(error, 'Failed to edit message'));
			} finally {
				savingRef.current = false;
			}
		},
		[message.id, onBlur],
	);

	return (
		<div className="flex flex-col gap-2">
			<div className="bg-muted/60 flex items-center gap-2 rounded-xl border border-border px-2 py-2">
				<AutoFocus>
					<TiptapInput
						value={value}
						onChange={setValue}
						onSubmit={() => onSubmit(value)}
						onCancel={onBlur}
						variant="chat-composer"
					/>
				</AutoFocus>
			</div>
			<span className="text-xs text-primary/60">Press Enter to save, Esc to cancel</span>
		</div>
	);
});

export { MessageEditInline };
