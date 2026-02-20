import { TiptapInput } from '@/components/tiptap-input';
import Spinner from '@/components/ui/spinner';
import { openServerScreen } from '@/features/server-screens/actions';
import { useChannelById } from '@/features/server/channels/hooks';
import {
  useCan,
  useChannelCan,
  useTypingUsersByChannelId
} from '@/features/server/hooks';
import { useMessages } from '@/features/server/messages/hooks';
import { useFlatPluginCommands } from '@/features/server/plugins/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useUploadFiles } from '@/hooks/use-upload-files';
import { getTRPCClient } from '@/lib/trpc';
import {
  ChannelPermission,
  Permission,
  TYPING_MS,
  isEmptyMessage
} from '@sharkord/shared';
import { filesize } from 'filesize';
import { throttle } from 'lodash-es';
import { Hash, Pencil, Plus, Send } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ServerScreen } from '../../server-screens/screens';
import { Button } from '../../ui/button';
import { FileCard } from './file-card';
import { MessagesGroup } from './messages-group';
import { TextSkeleton } from './text-skeleton';
import { useScrollController } from './use-scroll-controller';
import { UsersTyping } from './users-typing';

type TChannelProps = {
  channelId: number;
};

const TextChannel = memo(({ channelId }: TChannelProps) => {
  const {
    messages,
    hasMore,
    loadMore,
    loading,
    fetching,
    groupedMessages,
    isEmpty
  } = useMessages(channelId);

  const [newMessage, setNewMessage] = useState('');
  const allPluginCommands = useFlatPluginCommands();
  const channel = useChannelById(channelId);
  const typingUsers = useTypingUsersByChannelId(channelId);

  const { containerRef, onScroll } = useScrollController({
    messages,
    fetching,
    hasMore,
    loadMore,
    hasTypingUsers: typingUsers.length > 0
  });

  // keep this ref just as a safeguard
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const can = useCan();
  const channelCan = useChannelCan(channelId);

  const canSendMessages = useMemo(() => {
    return (
      can(Permission.SEND_MESSAGES) &&
      channelCan(ChannelPermission.SEND_MESSAGES)
    );
  }, [can, channelCan]);

  const canUploadFiles = useMemo(() => {
    return (
      can(Permission.SEND_MESSAGES) &&
      can(Permission.UPLOAD_FILES) &&
      channelCan(ChannelPermission.SEND_MESSAGES)
    );
  }, [can, channelCan]);

  const pluginCommands = useMemo(
    () =>
      can(Permission.EXECUTE_PLUGIN_COMMANDS) ? allPluginCommands : undefined,
    [can, allPluginCommands]
  );

  const {
    files,
    removeFile,
    clearFiles,
    uploading,
    uploadingSize,
    openFileDialog,
    fileInputProps
  } = useUploadFiles(!canSendMessages);

  const canManageChannel = can(Permission.MANAGE_CHANNELS);

  const sendTypingSignal = useMemo(
    () =>
      throttle(async () => {
        const trpc = getTRPCClient();

        try {
          await trpc.messages.signalTyping.mutate({ channelId });
        } catch {
          // ignore
        }
      }, TYPING_MS),
    [channelId]
  );

  const onSendMessage = useCallback(async () => {
    if (
      (isEmptyMessage(newMessage) && !files.length) ||
      !canSendMessages ||
      sendingRef.current
    ) {
      return;
    }

    setSending(true);
    sendingRef.current = true;
    sendTypingSignal.cancel();

    const trpc = getTRPCClient();

    try {
      await trpc.messages.send.mutate({
        content: newMessage,
        channelId,
        files: files.map((f) => f.id)
      });

      playSound(SoundType.MESSAGE_SENT);
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to send message'));
      return;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }

    setNewMessage('');
    clearFiles();
  }, [
    newMessage,
    channelId,
    files,
    clearFiles,
    sendTypingSignal,
    canSendMessages
  ]);

  const onRemoveFileClick = useCallback(
    async (fileId: string) => {
      removeFile(fileId);

      const trpc = getTRPCClient();

      try {
        trpc.files.deleteTemporary.mutate({ fileId });
      } catch {
        // ignore error
      }
    },
    [removeFile]
  );

  if (!channelCan(ChannelPermission.VIEW_CHANNEL) || loading) {
    return <TextSkeleton />;
  }

  return (
    <>
      {fetching && (
        <div className="absolute top-0 left-0 right-0 h-12 z-10 flex items-center justify-center">
          <div className="flex items-center gap-2 bg-background/80 backdrop-blur-sm border border-border rounded-full px-4 py-2 shadow-lg">
            <Spinner size="xs" />
            <span className="text-sm text-muted-foreground">
              Fetching older messages...
            </span>
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden p-2 animate-in fade-in duration-500"
      >
        {isEmpty ? (
          <div className="flex min-h-full items-end px-3 pb-6">
            <div className="max-w-2xl space-y-4">
              <div className="bg-muted/70 flex h-20 w-20 items-center justify-center rounded-full border border-border">
                <Hash className="h-11 w-11 text-foreground" />
              </div>

              <div className="space-y-2">
                <h2 className="text-4xl leading-tight font-bold tracking-tight md:text-[2.8rem]">
                  Welcome to #{channel?.name ?? 'channel'}!
                </h2>
                <p className="text-lg text-muted-foreground md:text-xl">
                  This is the start of the #{channel?.name ?? 'channel'}{' '}
                  channel.
                </p>
              </div>

              {canManageChannel && (
                <Button
                  variant="secondary"
                  className="h-11 px-4 text-base"
                  onClick={() =>
                    openServerScreen(ServerScreen.CHANNEL_SETTINGS, {
                      channelId
                    })
                  }
                >
                  <Pencil className="h-4 w-4" />
                  Edit Channel
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {groupedMessages.map((group, index) => (
              <MessagesGroup key={index} group={group} />
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col border-t border-border">
        {(uploading || files.length > 0 || typingUsers.length > 0) && (
          <div className="flex flex-col gap-2 px-2 pt-2">
            {uploading && (
              <div className="flex items-center gap-2">
                <div className="text-xs text-muted-foreground mb-1">
                  Uploading files ({filesize(uploadingSize)})
                </div>
                <Spinner size="xxs" />
              </div>
            )}
            {files.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {files.map((file) => (
                  <FileCard
                    key={file.id}
                    name={file.originalName}
                    extension={file.extension}
                    size={file.size}
                    onRemove={() => onRemoveFileClick(file.id)}
                  />
                ))}
              </div>
            )}
            <UsersTyping channelId={channelId} />
          </div>
        )}
        <div className="flex items-center px-2 py-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] md:h-14 md:p-2">
          <div className="bg-muted/60 flex h-10 w-full items-center gap-1 rounded-xl border border-border px-2">
            <input {...fileInputProps} />
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              disabled={uploading || !canUploadFiles}
              onClick={openFileDialog}
              title="Upload files"
            >
              <Plus className="h-5 w-5" />
            </Button>
            <TiptapInput
              value={newMessage}
              onChange={setNewMessage}
              onSubmit={onSendMessage}
              onTyping={sendTypingSignal}
              disabled={uploading || !canSendMessages}
              readOnly={sending}
              commands={pluginCommands}
              variant="chat-composer"
            />
            <Button
              size="icon"
              variant="secondary"
              className="h-8 w-8 shrink-0 rounded-full"
              onClick={onSendMessage}
              disabled={
                uploading || sending || !newMessage.trim() || !canSendMessages
              }
              title="Send message"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </>
  );
});

export { TextChannel };
