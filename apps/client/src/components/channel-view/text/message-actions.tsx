import { EmojiPicker } from '@/components/emoji-picker';
import { useRecentEmojis } from '@/components/emoji-picker/use-recent-emojis';
import { Protect } from '@/components/protect';
import type { TEmojiItem } from '@/components/tiptap-input/types';
import { IconButton } from '@/components/ui/icon-button';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Permission } from '@sharkord/shared';
import { Pencil, Smile, Trash } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { toast } from 'sonner';

const MAX_QUICK_EMOJIS = 4;

type TMessageActionsProps = {
  visible: boolean;
  anchorToGroup?: boolean;
  messageId: number;
  onEdit: () => void;
  canManage: boolean;
  editable: boolean;
};

const MessageActions = memo(
  ({
    onEdit,
    messageId,
    canManage,
    editable,
    visible,
    anchorToGroup
  }: TMessageActionsProps) => {
    const { recentEmojis } = useRecentEmojis();
    const recentEmojisToShow = useMemo(
      () => recentEmojis.slice(0, MAX_QUICK_EMOJIS),
      [recentEmojis]
    );

    const onDeleteClick = useCallback(async () => {
      const choice = await requestConfirmation({
        title: 'Delete Message',
        message:
          'Are you sure you want to delete this message? This action is irreversible.',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel'
      });

      if (!choice) return;

      const trpc = getTRPCClient();

      try {
        await trpc.messages.delete.mutate({ messageId });
        toast.success('Message deleted');
      } catch {
        toast.error('Failed to delete message');
      }
    }, [messageId]);

    const onEmojiSelect = useCallback(
      async (emoji: TEmojiItem) => {
        const trpc = getTRPCClient();

        try {
          await trpc.messages.toggleReaction.mutate({
            messageId,
            emoji: emoji.shortcodes[0]
          });
        } catch (error) {
          toast.error('Failed to add reaction');

          console.error('Error adding reaction:', error);
        }
      },
      [messageId]
    );

    return (
      <div
        className={cn(
          'absolute z-10 flex h-10 items-center gap-1 rounded-xl border border-border bg-popover p-1.5 shadow-lg transition-opacity',
          anchorToGroup ? 'top-2 right-2' : '-top-8 right-1',
          visible ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
        {canManage && (
          <>
            <IconButton
              size="sm"
              variant="ghost"
              icon={Pencil}
              className="bg-card hover:bg-accent h-7 w-7 rounded-md"
              onClick={onEdit}
              disabled={!editable}
              title="Edit Message"
            />

            <IconButton
              size="sm"
              variant="ghost"
              icon={Trash}
              className="bg-card hover:bg-accent h-7 w-7 rounded-md"
              onClick={onDeleteClick}
              title="Delete Message"
            />
          </>
        )}
        <Protect permission={Permission.REACT_TO_MESSAGES}>
          <div className="flex items-center gap-1 border-l border-border pl-1.5">
            {recentEmojisToShow.map((emoji) => (
              <button
                key={emoji.name}
                type="button"
                onClick={() => onEmojiSelect(emoji)}
                className="bg-card hover:bg-accent flex h-7 w-7 items-center justify-center rounded-md transition-colors"
                title={`:${emoji.shortcodes[0]}:`}
              >
                {emoji.emoji ? (
                  <span>{emoji.emoji}</span>
                ) : (
                  <img
                    src={emoji.fallbackImage}
                    alt={emoji.name}
                    className="h-5 w-5 object-contain"
                  />
                )}
              </button>
            ))}

            <EmojiPicker onEmojiSelect={onEmojiSelect}>
              <IconButton
                variant="ghost"
                icon={Smile}
                className="bg-card hover:bg-accent h-7 w-7 rounded-md"
                title="Add Reaction"
              />
            </EmojiPicker>
          </div>
        </Protect>
      </div>
    );
  }
);

export { MessageActions };
