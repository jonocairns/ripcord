import { FileCategory, getFileCategory, type TJoinedMessage } from '@sharkord/shared';
import parse from 'html-react-parser';
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
import { serializer } from './serializer';
import type { TFoundMedia } from './types';

type TMessageRendererProps = {
	message: TJoinedMessage;
};

const MessageRenderer = memo(({ message }: TMessageRendererProps) => {
	const ownUserId = useOwnUserId();
	const isOwnMessage = useMemo(() => message.userId === ownUserId, [message.userId, ownUserId]);

	const { foundMedia, messageHtml } = useMemo(() => {
		const foundMedia: TFoundMedia[] = [];

		const messageHtml = parse(message.content ?? '', {
			replace: (domNode) => serializer(domNode, (found) => foundMedia.push(found), message.id),
		});

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
				if (media.type === 'image') {
					return <ImageOverride src={media.url} key={`media-image-${index}`} />;
				}

				if (media.type === 'video') {
					return <VideoOverride src={media.url} key={`media-video-${index}`} />;
				}

				if (media.type === 'audio') {
					const mediaFile = media.file;

					return (
						<AudioOverride
							src={media.url}
							name={mediaFile?.originalName ?? 'Audio file'}
							size={mediaFile?.size}
							href={media.url}
							onRemove={mediaFile && isOwnMessage ? () => onRemoveFileClick(mediaFile.id) : undefined}
							key={`media-audio-${index}`}
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
