import type { TJoinedMessage } from '@sharkord/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { logDebug } from '@/helpers/browser-logger';
import { getTRPCClient, getTRPCClientIfInitialized, isTRPCSocketOpen } from '@/lib/trpc';
import { getFileLinkVersion, subscribeToNonceBumps } from '../nonce-signals';
import { serverRejoinNonceSelector } from '../selectors';
import { useServerStore } from '../slice';
import {
	addMessages,
	applyLatestMessagePage,
	refreshChannelFileAccessTokens,
	refreshExpiringFileAccessTokens,
	refreshLoadedFileAccessTokens,
} from './actions';
import { FILE_ACCESS_TOKEN_CHECK_INTERVAL_MS } from './file-access-tokens';
import { loadMessagePage } from './load-message-page';
import { createMessagePageRequest, subscribeToMessageMutations } from './message-page-request';
import { messagesByChannelIdSelector } from './selectors';
import { getMessageSession } from './subscriptions';

const INITIAL_MESSAGES_LIMIT = 20;
const OLDER_MESSAGES_LIMIT = 20;

export const useMessagesByChannelId = (channelId: number) =>
	useServerStore((state) => messagesByChannelIdSelector(state, channelId));

export const useMessages = (channelId: number) => {
	const messages = useMessagesByChannelId(channelId);
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const channelRef = useRef(channelId);
	channelRef.current = channelId;
	const requests = useMemo(() => createMessagePageRequest(), []);
	const [fetching, setFetching] = useState(false);
	const [loading, setLoading] = useState(messages.length === 0);
	const [cursor, setCursor] = useState<number | null>(null);
	const [hasMore, setHasMore] = useState(true);

	const fetchMessages = useCallback(
		async (cursorToFetch: number | null, limit: number, reconcile = false) => {
			const state = useServerStore.getState();
			const client = getTRPCClientIfInitialized();
			const nonce = serverRejoinNonceSelector(state);
			const session = getMessageSession();
			const request = requests.begin(() => {
				const current = useServerStore.getState();
				return (
					channelRef.current === channelId &&
					session === getMessageSession() &&
					current.connected &&
					current.serverId === state.serverId &&
					serverRejoinNonceSelector(current) === nonce &&
					client === getTRPCClientIfInitialized() &&
					isTRPCSocketOpen()
				);
			}, reconcile);
			setFetching(true);
			try {
				const trpcClient = getTRPCClient();
				const nextCursor = await loadMessagePage({
					query: () => trpcClient.messages.get.query({ channelId, cursor: cursorToFetch, limit }),
					isCurrent: request.isCurrent,
					getLoadedMessages: () => messagesRef.current,
					getFileLinkVersion,
					applyLatestMessagePage: reconcile
						? (page) => {
								applyLatestMessagePage(channelId, request.reconcile(page));
							}
						: undefined,
					addMessages: (page) => addMessages(channelId, page, { prepend: cursorToFetch !== null }),
					refreshFileAccessTokens: () => refreshChannelFileAccessTokens(channelId),
				});
				if (request.isCurrent()) {
					setCursor(nextCursor);
					setHasMore(nextCursor !== null);
				}
			} catch (error) {
				if (request.isCurrent()) logDebug('Message page load failed', error);
			} finally {
				if (request.isCurrent()) {
					setFetching(false);
					setLoading(false);
				}
				request.finish();
			}
		},
		[channelId, requests],
	);

	const loadMore = useCallback(async () => {
		if (fetching || !hasMore) return;
		await fetchMessages(cursor, OLDER_MESSAGES_LIMIT);
	}, [fetching, hasMore, cursor, fetchMessages]);

	useEffect(() => {
		const unsubscribeEvents = subscribeToMessageMutations((eventChannelId, mutation) => {
			if (eventChannelId === channelId) requests.record(mutation);
		});
		const unsubscribeState = useServerStore.subscribe((state, previous) => {
			if (
				state.serverId !== previous.serverId ||
				(previous.connected && !state.connected) ||
				serverRejoinNonceSelector(state) < serverRejoinNonceSelector(previous)
			)
				requests.invalidate();
		});
		// A cached inactive channel may have missed any number of rejoins.
		void fetchMessages(null, INITIAL_MESSAGES_LIMIT, messagesRef.current.length > 0);
		const unsubscribeRejoins = subscribeToNonceBumps(serverRejoinNonceSelector, () => {
			void fetchMessages(null, INITIAL_MESSAGES_LIMIT, true);
		});
		return () => {
			requests.invalidate();
			unsubscribeEvents();
			unsubscribeState();
			unsubscribeRejoins();
		};
	}, [channelId, fetchMessages, requests]);

	const isEmpty = useMemo(() => !messages.length && !fetching, [messages.length, fetching]);

	const groupedMessages = useMemo(() => {
		const grouped = messages.reduce<TJoinedMessage[][]>((acc, message) => {
			const last = acc[acc.length - 1];

			if (!last) return [[message]];

			const lastMessage = last[last.length - 1];

			if (lastMessage.userId === message.userId) {
				const lastDate = lastMessage.createdAt;
				const currentDate = message.createdAt;
				const timeDifference = Math.abs(currentDate - lastDate) / 1000 / 60;

				if (timeDifference < 1) {
					last.push(message);
					return acc;
				}
			}

			return [...acc, [message]];
		}, []);

		return grouped;
	}, [messages]);

	return {
		fetching,
		loading, // for initial load
		hasMore,
		messages,
		loadMore,
		cursor,
		groupedMessages,
		isEmpty,
	};
};

// Keeps the file links of loaded messages working for the whole session. Tokens
// close to expiry are refreshed on mount, on window focus and on a timer. After
// a confirmed rejoin every loaded channel refreshes, since a rotation or private
// toggle may have happened while disconnected. CHANNEL_FILE_ACCESS_CHANGED and
// media load failures refresh single channels elsewhere.
export const useFileAccessTokenRefresh = () => {
	useEffect(() => {
		const refreshExpiring = () => {
			void refreshExpiringFileAccessTokens(Date.now());
		};

		refreshExpiring();

		const interval = setInterval(refreshExpiring, FILE_ACCESS_TOKEN_CHECK_INTERVAL_MS);
		const unsubscribeFromRejoins = subscribeToNonceBumps(serverRejoinNonceSelector, () => {
			void refreshLoadedFileAccessTokens();
		});

		window.addEventListener('focus', refreshExpiring);

		return () => {
			clearInterval(interval);
			unsubscribeFromRejoins();
			window.removeEventListener('focus', refreshExpiring);
		};
	}, []);
};
