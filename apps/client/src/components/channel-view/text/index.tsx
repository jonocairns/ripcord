import { ChannelPermission, isEmptyMessage, Permission } from '@sharkord/shared';
import { isSameDay } from 'date-fns';
import { filesize } from 'filesize';
import { Hash, Pencil, Plus, Send } from 'lucide-react';
import { Fragment, memo, useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { TiptapInput } from '@/components/tiptap-input';
import Spinner from '@/components/ui/spinner';
import { useChannelById } from '@/features/server/channels/hooks';
import { useCan, useChannelCan } from '@/features/server/hooks';
import { useMessages } from '@/features/server/messages/hooks';
import { useFlatPluginCommands } from '@/features/server/plugins/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { openServerScreen } from '@/features/server-screens/actions';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useUploadFiles } from '@/hooks/use-upload-files';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { ServerScreen } from '../../server-screens/screens';
import { Button } from '../../ui/button';
import { ChannelHeader } from './channel-header';
import { DateDivider } from './date-divider';
import { FileCard } from './file-card';
import { MessagesGroup } from './messages-group';
import { TextSkeleton } from './text-skeleton';
import { useScrollController } from './use-scroll-controller';

type TChannelProps = {
	channelId: number;
};

const TextChannel = memo(({ channelId }: TChannelProps) => {
	const { messages, hasMore, loadMore, loading, fetching, groupedMessages, isEmpty } = useMessages(channelId);

	const [newMessage, setNewMessage] = useState('');
	const allPluginCommands = useFlatPluginCommands();
	const channel = useChannelById(channelId);

	const { containerRef, onScroll } = useScrollController({
		messages,
		fetching,
		hasMore,
		loadMore,
	});

	// keep this ref just as a safeguard
	const sendingRef = useRef(false);
	const [sending, setSending] = useState(false);
	const can = useCan();
	const channelCan = useChannelCan(channelId);

	const canSendMessages = useMemo(() => {
		return can(Permission.SEND_MESSAGES) && channelCan(ChannelPermission.SEND_MESSAGES);
	}, [can, channelCan]);

	const canUploadFiles = useMemo(() => {
		return can(Permission.SEND_MESSAGES) && can(Permission.UPLOAD_FILES) && channelCan(ChannelPermission.SEND_MESSAGES);
	}, [can, channelCan]);

	const pluginCommands = useMemo(
		() => (can(Permission.EXECUTE_PLUGIN_COMMANDS) ? allPluginCommands : undefined),
		[can, allPluginCommands],
	);

	const { files, removeFile, clearFiles, uploading, uploadingSize, openFileDialog, fileInputProps } = useUploadFiles(
		!canSendMessages,
	);

	// tiptap emits HTML (an empty editor is "<p></p>"), so a plain string check is
	// always truthy — use isEmptyMessage. Files alone are also sendable.
	const hasContent = useMemo(() => !isEmptyMessage(newMessage) || files.length > 0, [newMessage, files.length]);

	const canManageChannel = can(Permission.MANAGE_CHANNELS);

	const onSendMessage = useCallback(async () => {
		if ((isEmptyMessage(newMessage) && !files.length) || !canSendMessages || sendingRef.current) {
			return;
		}

		setSending(true);
		sendingRef.current = true;

		const trpc = getTRPCClient();

		try {
			await trpc.messages.send.mutate({
				content: newMessage,
				channelId,
				files: files.map((f) => f.id),
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
	}, [newMessage, channelId, files, clearFiles, canSendMessages]);

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
		[removeFile],
	);

	if (!channelCan(ChannelPermission.VIEW_CHANNEL) || loading) {
		return <TextSkeleton />;
	}

	return (
		<>
			<ChannelHeader channelId={channelId} />

			{fetching && (
				<div className="absolute top-12 left-0 right-0 h-12 z-10 flex items-center justify-center">
					<div className="flex items-center gap-2 bg-background/80 backdrop-blur-sm border border-border rounded-full px-4 py-2 shadow-lg">
						<Spinner size="xs" />
						<span className="text-sm text-muted-foreground">Fetching older messages...</span>
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
						<div className="max-w-2xl space-y-5">
							<div className="bg-muted/70 flex h-20 w-20 items-center justify-center rounded-full border border-border">
								<Hash className="h-11 w-11 text-foreground" />
							</div>

							<div className="space-y-3">
								<h2 className="text-3xl leading-tight font-semibold tracking-tight md:text-[2.35rem]">
									Welcome to #{channel?.name ?? 'channel'}!
								</h2>
								<p className="max-w-xl text-base text-muted-foreground">
									Welcome to #{channel?.name ?? 'channel'}. Send the first message to get started.
								</p>
							</div>

							{canManageChannel && (
								<Button
									variant="secondary"
									className="h-10 px-4 text-sm"
									onClick={() =>
										openServerScreen(ServerScreen.CHANNEL_SETTINGS, {
											channelId,
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
						{groupedMessages.map((group, index) => {
							const previousGroup = groupedMessages[index - 1];
							const groupDate = new Date(group[0].createdAt);
							const showDateDivider =
								!previousGroup || !isSameDay(groupDate, new Date(previousGroup[0].createdAt));

							return (
								<Fragment key={index}>
									{showDateDivider && <DateDivider date={groupDate} />}
									<MessagesGroup group={group} />
								</Fragment>
							);
						})}
					</div>
				)}
			</div>

			<div className="flex shrink-0 flex-col border-t border-border">
				{(uploading || files.length > 0) && (
					<div className="flex flex-col gap-2 px-2 pt-2">
						{uploading && (
							<div className="flex items-center gap-2">
								<div className="text-xs text-muted-foreground mb-1">Uploading files ({filesize(uploadingSize)})</div>
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
					</div>
				)}
				<div className="flex items-center px-2 py-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] md:h-14 md:p-2">
					<div className="bg-muted/60 flex h-10 w-full items-center gap-1 rounded-md border border-border px-1 transition-colors focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/40">
						<input {...fileInputProps} />
						<Button
							size="icon"
							variant="ghost"
							className="h-8 w-8 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
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
							disabled={uploading || !canSendMessages}
							readOnly={sending}
							commands={pluginCommands}
							variant="chat-composer"
						/>
						<Button
							size="icon"
							variant={hasContent ? 'default' : 'ghost'}
							className={cn(
								'h-8 w-8 shrink-0 rounded-md transition-colors [&_svg]:-translate-x-px [&_svg]:translate-y-px',
								!hasContent && 'text-muted-foreground hover:text-foreground',
							)}
							onClick={onSendMessage}
							disabled={uploading || sending || !hasContent || !canSendMessages}
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
