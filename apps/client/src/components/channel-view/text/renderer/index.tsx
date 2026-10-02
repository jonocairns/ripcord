import { FileCategory, getFileCategory, type TJoinedMessage } from '@sharkord/shared';
import { memo, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { requestConfirmation } from '@/features/dialogs/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { getTRPCClient } from '@/lib/trpc';
import { FileCard } from '../file-card';
import { MessageReactions } from '../message-reactions';
import { AudioOverride } from '../overrides/audio';
import { ImageOverride } from '../overrides/image';
import { VideoOverride } from '../overrides/video';
import { FileMedia } from './file-media';
import { parseMessageHtml } from './serializer';
import type { TFoundMedia } from './types';

type TMessageRendererProps = {
	message: TJoinedMessage;
};

const MessageRenderer = memo(({ message }: TMessageRendererProps) => {
	const ownUserId = useOwnUserId();
	const isOwnMessage = useMemo(() => message.userId === ownUserId, [message.userId, ownUserId]);

	const { foundMedia, messageHtml } = useMemo(() => {
		const foundMedia: TFoundMedia[] = [];

		const messageHtml = parseMessageHtml(message.content ?? '', (found) => foundMedia.push(found), message.id);

		return { messageHtml, foundMedia };
	}, [message.content, message.id]);

	const onRemoveFileClick = useCallback(async (fileId: number) => {
		if (!fileId) return;

		const choice = await requestConfirmation({
			title: 'Delete file',
			message: 'Are you sure you want to delete this file?',
			confirmLabel: 'Delete',
		});

		if (!choice) return;

		const trpc = getTRPCClient();

		try {
			await trpc.files.delete.mutate({
				fileId,
			});

			toast.success('File deleted');
		} catch {
			toast.error('Failed to delete file');
		}
	}, []);

	const allMedia = useMemo(() => {
		const mediaFromFiles: TFoundMedia[] = [];

		for (const file of message.files) {
			const category = getFileCategory(file.extension);

			if (category === FileCategory.IMAGE) {
				mediaFromFiles.push({ type: 'image', url: getFileUrl(file), file });
			} else if (category === FileCategory.VIDEO) {
				mediaFromFiles.push({ type: 'video', url: getFileUrl(file), file });
			} else if (category === FileCategory.AUDIO) {
				mediaFromFiles.push({ type: 'audio', url: getFileUrl(file), file });
			}
		}

		return [...foundMedia, ...mediaFromFiles];
	}, [foundMedia, message.files]);

	const cardFiles = useMemo(() => {
		return message.files.filter((file) => {
			const category = getFileCategory(file.extension);
			return category !== FileCategory.VIDEO && category !== FileCategory.AUDIO;
		});
	}, [message.files]);

	return (
		<div className="flex flex-col gap-1">
			<div className="prose max-w-full break-words msg-content">{messageHtml}</div>

			{allMedia.map((media, index) => {
				const mediaFile = media.file;

				if (mediaFile) {
					return (
						<FileMedia
							channelId={message.channelId}
							file={mediaFile}
							type={media.type}
							onRemove={isOwnMessage ? () => onRemoveFileClick(mediaFile.id) : undefined}
							key={`media-file-${mediaFile.id}`}
						/>
					);
				}

				// Keyed by URL so an edited link remounts with a clean error state.
				if (media.type === 'image') {
					return <ImageOverride src={media.url} key={`media-image-${index}-${media.url}`} />;
				}

				if (media.type === 'video') {
					return <VideoOverride src={media.url} key={`media-video-${index}-${media.url}`} />;
				}

				if (media.type === 'audio') {
					return (
						<AudioOverride
							src={media.url}
							name="Audio file"
							href={media.url}
							key={`media-audio-${index}-${media.url}`}
						/>
					);
				}

				return null;
			})}

			<MessageReactions reactions={message.reactions} messageId={message.id} />

			{cardFiles.length > 0 && (
				<div className="flex gap-1 flex-wrap">
					{cardFiles.map((file) => (
						<FileCard
							key={file.id}
							name={file.originalName}
							extension={file.extension}
							size={file.size}
							onRemove={isOwnMessage ? () => onRemoveFileClick(file.id) : undefined}
							href={getFileUrl(file)}
						/>
					))}
				</div>
			)}
		</div>
	);
});

export { MessageRenderer };
