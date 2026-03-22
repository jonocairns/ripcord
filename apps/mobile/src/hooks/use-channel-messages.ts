import * as ImagePicker from 'expo-image-picker';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TFile, TJoinedMessage, TJoinedMessageReaction, TTempFile } from '@sharkord/shared';
import {
	deleteMessage,
	deleteTemporaryFile,
	editMessage,
	loadMessagesPageIntoStore,
	markChannelAsRead,
	sendMessage,
	setSelectedChannel,
	signalTyping,
	toggleMessageReaction,
	type TUploadInput,
	uploadFiles,
	useServerStore,
} from '@sharkord/app-core';

type TOptimisticSend = {
	message: TOptimisticMessage;
	resolvedMessageId?: number;
};

type TOptimisticMessage = {
	channelId: number;
	content: string;
	createdAt: number;
	editable: boolean | null;
	id: number;
	pendingFiles: TTempFile[];
	reactions: TJoinedMessageReaction[];
	updatedAt: number | null;
	userId: number;
};

type TOptimisticEdit = {
	content: string;
	updatedAt: number;
};

type TDisplayedMessage = {
	channelId: number;
	content: string;
	createdAt: number;
	deliveryState?: 'editing' | 'sending';
	editable: boolean | null;
	files: TFile[];
	id: number;
	isOptimistic: boolean;
	pendingFiles: TTempFile[];
	reactions: TJoinedMessageReaction[];
	updatedAt: number | null;
	userId: number;
};

const createReactionSignature = (reactions: TJoinedMessageReaction[]) =>
	[...reactions]
		.sort((left, right) => {
			if (left.emoji !== right.emoji) {
				return left.emoji.localeCompare(right.emoji);
			}

			if (left.userId !== right.userId) {
				return left.userId - right.userId;
			}

			return left.createdAt - right.createdAt;
		})
		.map((reaction) => `${reaction.emoji}:${reaction.userId}:${reaction.createdAt}:${reaction.fileId ?? 'null'}`)
		.join('|');

const getErrorMessage = (error: unknown, fallback: string) => {
	return error instanceof Error ? error.message : fallback;
};

const buildUploadInputFromAsset = async (asset: ImagePicker.ImagePickerAsset, index: number): Promise<TUploadInput> => {
	const response = await fetch(asset.uri);
	const body = await response.blob();
	const fallbackName = asset.fileName ?? `upload-${Date.now()}-${index}`;

	return {
		body,
		name: fallbackName,
		size: asset.fileSize ?? body.size,
		type: asset.mimeType ?? body.type ?? 'application/octet-stream',
	};
};

const applyOptimisticReaction = ({
	emoji,
	message,
	ownUserId,
}: {
	emoji: string;
	message: Pick<TDisplayedMessage, 'id' | 'reactions'>;
	ownUserId: number;
}) => {
	const existingOwnReaction = message.reactions.find(
		(reaction) => reaction.userId === ownUserId && reaction.emoji === emoji,
	);

	if (existingOwnReaction) {
		return message.reactions.filter((reaction) => !(reaction.userId === ownUserId && reaction.emoji === emoji));
	}

	const existingReaction = message.reactions.find((reaction) => reaction.emoji === emoji);

	return [
		...message.reactions,
		{
			createdAt: Date.now(),
			emoji,
			file: existingReaction?.file ?? null,
			fileId: existingReaction?.fileId ?? null,
			messageId: message.id,
			userId: ownUserId,
		},
	];
};

const buildOptimisticMessage = ({
	channelId,
	content,
	id,
	ownUserId,
	pendingFiles,
}: {
	channelId: number;
	content: string;
	id: number;
	ownUserId: number;
	pendingFiles: TTempFile[];
}): TOptimisticMessage => ({
	channelId,
	content,
	createdAt: Date.now(),
	editable: true,
	id,
	pendingFiles,
	reactions: [],
	updatedAt: null,
	userId: ownUserId,
});

const EMPTY_MESSAGES: TJoinedMessage[] = [];

const useChannelMessages = (channelId: number) => {
	const messages = useServerStore((state) => state.messagesMap[channelId] ?? EMPTY_MESSAGES);
	const channel = useServerStore((state) => state.channels.find((entry) => entry.id === channelId));
	const ownUserId = useServerStore((state) => state.ownUserId);
	const typingUsers = useServerStore((state) => {
		const typingIds = state.typingMap[channelId] ?? [];
		return typingIds
			.filter((id) => id !== state.ownUserId)
			.map((id) => state.users.find((user) => user.id === id)?.name)
			.filter((value): value is string => Boolean(value));
	});

	const [composerValue, setComposerValue] = useState('');
	const [editingMessageId, setEditingMessageId] = useState<number>();
	const [pendingUploads, setPendingUploads] = useState<TTempFile[]>([]);
	const [error, setError] = useState<string>();
	const [loadingInitial, setLoadingInitial] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [cursor, setCursor] = useState<number | null>(null);
	const [hasMore, setHasMore] = useState(true);
	const [optimisticSends, setOptimisticSends] = useState<TOptimisticSend[]>([]);
	const [optimisticEdits, setOptimisticEdits] = useState<Record<number, TOptimisticEdit>>({});
	const [optimisticDeletedMessageIds, setOptimisticDeletedMessageIds] = useState<Record<number, true>>({});
	const [optimisticReactions, setOptimisticReactions] = useState<Record<number, TJoinedMessageReaction[]>>({});
	const [pendingReactionKeys, setPendingReactionKeys] = useState<Record<string, true>>({});
	const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const nextOptimisticIdRef = useRef(-1);

	useEffect(() => {
		setComposerValue('');
		setEditingMessageId(undefined);
		setPendingUploads([]);
		setError(undefined);
		setCursor(null);
		setHasMore(true);
		setLoadingInitial(true);
		setLoadingMore(false);
		setOptimisticSends([]);
		setOptimisticEdits({});
		setOptimisticDeletedMessageIds({});
		setOptimisticReactions({});
		setPendingReactionKeys({});
		setSelectedChannel(channelId);

		let cancelled = false;

		void (async () => {
			try {
				const response = await loadMessagesPageIntoStore({ channelId, cursor: null });

				if (cancelled) {
					return;
				}

				setCursor(response.nextCursor);
				setHasMore(response.nextCursor !== null);
				await markChannelAsRead(channelId);
			} catch (nextError) {
				if (!cancelled) {
					setError(getErrorMessage(nextError, 'Could not load messages'));
				}
			} finally {
				if (!cancelled) {
					setLoadingInitial(false);
				}
			}
		})();

		return () => {
			cancelled = true;
			setSelectedChannel(undefined);

			if (typingTimeoutRef.current) {
				clearTimeout(typingTimeoutRef.current);
				typingTimeoutRef.current = null;
			}
		};
	}, [channelId]);

	useEffect(() => {
		setOptimisticSends((current) => {
			const next = current.filter((entry) => {
				if (!entry.resolvedMessageId) {
					return true;
				}

				return !messages.some((message) => message.id === entry.resolvedMessageId);
			});

			return next.length === current.length ? current : next;
		});
	}, [messages]);

	useEffect(() => {
		setOptimisticEdits((current) => {
			let changed = false;
			const next: Record<number, TOptimisticEdit> = {};

			Object.entries(current).forEach(([messageIdKey, value]) => {
				const messageId = Number(messageIdKey);
				const matchingMessage = messages.find((message) => message.id === messageId);

				if (!matchingMessage || matchingMessage.content === value.content) {
					changed = true;
					return;
				}

				next[messageId] = value;
			});

			return changed ? next : current;
		});
	}, [messages]);

	useEffect(() => {
		setOptimisticDeletedMessageIds((current) => {
			let changed = false;
			const next: Record<number, true> = {};

			Object.keys(current).forEach((messageIdKey) => {
				const messageId = Number(messageIdKey);

				if (messages.some((message) => message.id === messageId)) {
					next[messageId] = true;
					return;
				}

				changed = true;
			});

			return changed ? next : current;
		});
	}, [messages]);

	useEffect(() => {
		setOptimisticReactions((current) => {
			let changed = false;
			const next: Record<number, TJoinedMessageReaction[]> = {};

			Object.entries(current).forEach(([messageIdKey, value]) => {
				const messageId = Number(messageIdKey);
				const matchingMessage = messages.find((message) => message.id === messageId);

				if (!matchingMessage || createReactionSignature(matchingMessage.reactions) === createReactionSignature(value)) {
					changed = true;
					return;
				}

				next[messageId] = value;
			});

			return changed ? next : current;
		});
	}, [messages]);

	const displayedMessages = useMemo<TDisplayedMessage[]>(() => {
		const resolvedMessageIds = new Set(
			optimisticSends
				.map((entry) => entry.resolvedMessageId)
				.filter((value): value is number => typeof value === 'number'),
		);

		const baseMessages = messages
			.filter((message) => optimisticDeletedMessageIds[message.id] !== true)
			.map<TDisplayedMessage>((message) => ({
				channelId: message.channelId,
				content: optimisticEdits[message.id]?.content ?? message.content ?? '',
				createdAt: message.createdAt,
				deliveryState: optimisticEdits[message.id] ? 'editing' : undefined,
				editable: message.editable,
				files: message.files,
				id: message.id,
				isOptimistic: false,
				pendingFiles: [],
				reactions: optimisticReactions[message.id] ?? message.reactions,
				updatedAt: optimisticEdits[message.id]?.updatedAt ?? message.updatedAt ?? null,
				userId: message.userId,
			}));

		const pendingMessages = optimisticSends
			.filter(
				(entry) =>
					!entry.resolvedMessageId ||
					!resolvedMessageIds.has(entry.resolvedMessageId) ||
					!messages.some((message) => message.id === entry.resolvedMessageId),
			)
			.map<TDisplayedMessage>((entry) => ({
				channelId: entry.message.channelId,
				content: entry.message.content,
				createdAt: entry.message.createdAt,
				deliveryState: 'sending',
				editable: entry.message.editable,
				files: [],
				id: entry.message.id,
				isOptimistic: true,
				pendingFiles: entry.message.pendingFiles,
				reactions: entry.message.reactions,
				updatedAt: entry.message.updatedAt,
				userId: entry.message.userId,
			}));

		return [...baseMessages, ...pendingMessages].sort((left, right) => left.createdAt - right.createdAt);
	}, [messages, optimisticDeletedMessageIds, optimisticEdits, optimisticReactions, optimisticSends]);

	const loadMore = async () => {
		if (loadingMore || !hasMore || cursor == null) {
			return;
		}

		setError(undefined);
		setLoadingMore(true);

		try {
			const response = await loadMessagesPageIntoStore({ channelId, cursor });
			setCursor(response.nextCursor);
			setHasMore(response.nextCursor !== null);
		} catch (nextError) {
			setError(getErrorMessage(nextError, 'Could not load older messages'));
		} finally {
			setLoadingMore(false);
		}
	};

	const onComposerChange = (value: string) => {
		setComposerValue(value);

		if (typingTimeoutRef.current) {
			clearTimeout(typingTimeoutRef.current);
		}

		typingTimeoutRef.current = setTimeout(() => {
			if (value.trim().length === 0) {
				return;
			}

			void signalTyping({ channelId }).catch(() => {
				// Best-effort only.
			});
		}, 250);
	};

	const pickUploads = async () => {
		if (editingMessageId) {
			setError('Attachments can only be added to new messages.');
			return;
		}

		setError(undefined);

		try {
			const result = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ['images'],
				quality: 0.8,
				selectionLimit: 3,
			});

			if (result.canceled) {
				return;
			}

			const filesToUpload = await Promise.all(
				result.assets.map((asset, index) => buildUploadInputFromAsset(asset, index)),
			);
			const uploadedFiles = await uploadFiles(filesToUpload);

			setPendingUploads((current) => [...current, ...uploadedFiles]);
		} catch (nextError) {
			setError(getErrorMessage(nextError, 'Could not upload files'));
		}
	};

	const removePendingUpload = async (fileId: string) => {
		setPendingUploads((current) => current.filter((file) => file.id !== fileId));

		try {
			await deleteTemporaryFile({ fileId });
		} catch {
			// Best-effort cleanup only.
		}
	};

	const startEditing = (message: Pick<TDisplayedMessage, 'content' | 'id'>) => {
		setComposerValue(message.content);
		setEditingMessageId(message.id);
		setPendingUploads([]);
		setError(undefined);
	};

	const cancelEditing = () => {
		setComposerValue('');
		setEditingMessageId(undefined);
		setError(undefined);
	};

	const submitComposer = async () => {
		const content = composerValue.trim();

		if (!ownUserId) {
			setError('You must be connected before sending messages.');
			return;
		}

		if (editingMessageId) {
			if (!content) {
				setError('Message cannot be empty.');
				return;
			}

			const optimisticUpdatedAt = Date.now();
			const messageId = editingMessageId;

			setError(undefined);
			setOptimisticEdits((current) => ({
				...current,
				[messageId]: {
					content,
					updatedAt: optimisticUpdatedAt,
				},
			}));
			setComposerValue('');
			setEditingMessageId(undefined);

			try {
				await editMessage({
					content,
					messageId,
				});
			} catch (nextError) {
				setOptimisticEdits((current) => {
					const next = { ...current };
					delete next[messageId];
					return next;
				});
				setComposerValue(content);
				setEditingMessageId(messageId);
				setError(getErrorMessage(nextError, 'Could not save message'));
			}

			return;
		}

		if (!content && pendingUploads.length === 0) {
			return;
		}

		const pendingFiles = pendingUploads;
		const optimisticMessageId = nextOptimisticIdRef.current;

		nextOptimisticIdRef.current -= 1;

		setError(undefined);
		setComposerValue('');
		setPendingUploads([]);
		setOptimisticSends((current) => [
			...current,
			{
				message: buildOptimisticMessage({
					channelId,
					content,
					id: optimisticMessageId,
					ownUserId,
					pendingFiles,
				}),
			},
		]);

		try {
			const messageId = await sendMessage({
				channelId,
				content,
				files: pendingFiles.map((file) => file.id),
			});

			setOptimisticSends((current) =>
				current.map((entry) => {
					if (entry.message.id !== optimisticMessageId) {
						return entry;
					}

					return {
						...entry,
						resolvedMessageId: messageId,
					};
				}),
			);
		} catch (nextError) {
			setOptimisticSends((current) => current.filter((entry) => entry.message.id !== optimisticMessageId));
			setComposerValue(content);
			setPendingUploads(pendingFiles);
			setError(getErrorMessage(nextError, 'Could not send message'));
		}
	};

	const deleteChannelMessage = async (messageId: number) => {
		setError(undefined);
		setOptimisticDeletedMessageIds((current) => ({
			...current,
			[messageId]: true,
		}));

		try {
			await deleteMessage({ messageId });
		} catch (nextError) {
			setOptimisticDeletedMessageIds((current) => {
				const next = { ...current };
				delete next[messageId];
				return next;
			});
			setError(getErrorMessage(nextError, 'Could not delete message'));
		}
	};

	const toggleReactionForMessage = async (messageId: number, emoji: string) => {
		if (!ownUserId) {
			setError('You must be connected before reacting to messages.');
			return;
		}

		const reactionKey = `${messageId}-${emoji}`;

		if (pendingReactionKeys[reactionKey]) {
			return;
		}

		const targetMessage = displayedMessages.find((message) => message.id === messageId);

		if (!targetMessage || targetMessage.isOptimistic) {
			return;
		}

		const nextReactions = applyOptimisticReaction({
			emoji,
			message: targetMessage,
			ownUserId,
		});

		setError(undefined);
		setPendingReactionKeys((current) => ({
			...current,
			[reactionKey]: true,
		}));
		setOptimisticReactions((current) => ({
			...current,
			[messageId]: nextReactions,
		}));

		try {
			await toggleMessageReaction({
				emoji,
				messageId,
			});
		} catch (nextError) {
			setOptimisticReactions((current) => {
				const next = { ...current };
				delete next[messageId];
				return next;
			});
			setError(getErrorMessage(nextError, 'Could not update reaction'));
		} finally {
			setPendingReactionKeys((current) => {
				const next = { ...current };
				delete next[reactionKey];
				return next;
			});
		}
	};

	return {
		cancelEditing,
		channel,
		composerValue,
		deleteMessage: deleteChannelMessage,
		displayedMessages,
		editingMessageId,
		error,
		hasMore,
		loadingInitial,
		loadingMore,
		onComposerChange,
		ownUserId,
		pendingUploads,
		pickUploads,
		removePendingUpload,
		startEditing,
		submitComposer,
		toggleReaction: toggleReactionForMessage,
		typingUsers,
		loadMore,
	};
};

export { useChannelMessages };
export type { TDisplayedMessage };
