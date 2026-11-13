import type { TJoinedMessage } from '@sharkord/shared';
import { loadMessagePage } from './load-message-page';
import { createMessagePageRequest, subscribeToMessageMutations } from './message-page-request';

type TSession = {
	channelId: number;
	messageSession: number;
	hasServerSession: boolean;
	serverId: string | undefined;
	nonce: number;
	client: unknown;
	socketOpen: boolean;
};
type TLoaderDeps = {
	channelId: number;
	getSession: () => TSession;
	query: (cursor: number | null, limit: number) => Promise<{ messages: TJoinedMessage[]; nextCursor: number | null }>;
	getLoadedMessages: () => TJoinedMessage[];
	getFileLinkVersion: () => string;
	applyLatestMessagePage: (messages: TJoinedMessage[]) => void;
	addMessages: (messages: TJoinedMessage[], prepend: boolean) => void;
	refreshFileAccessTokens: () => Promise<void>;
	setFetching: (fetching: boolean) => void;
	setLoading: (loading: boolean) => void;
	setCursor: (cursor: number | null) => void;
	setHasMore: (hasMore: boolean) => void;
	onError: (error: unknown) => void;
};

const MAX_EMPTY_PAGE_FOLLOW_UPS = 3;

// Owns request lifetime independently of React render timing. Session identity
// is captured at dispatch, including subscription replacement on a reused socket.
export const createMessagePageLoader = (deps: TLoaderDeps) => {
	const requests = createMessagePageRequest();
	let fetching = false;
	let unsubscribe: (() => void) | undefined;
	const invalidate = () => {
		requests.invalidate();
		// Cleanup may be followed by another effect setup on the same loader.
		fetching = false;
		unsubscribe?.();
		unsubscribe = undefined;
	};
	const fetch = async (cursor: number | null, limit: number, reconcile = false) => {
		// Scroll callbacks can still hold the previous render's fetching value.
		if (!reconcile && fetching) return;
		const session = deps.getSession();
		const request = requests.begin(() => {
			const current = deps.getSession();
			return (
				current.channelId === deps.channelId &&
				current.messageSession === session.messageSession &&
				current.hasServerSession &&
				current.serverId === session.serverId &&
				current.nonce === session.nonce &&
				current.client === session.client &&
				current.socketOpen
			);
		}, reconcile);
		unsubscribe?.();
		const stop = subscribeToMessageMutations((channelId, mutation) => {
			if (channelId === deps.channelId) requests.record(mutation);
		});
		unsubscribe = stop;
		fetching = true;
		deps.setFetching(true);
		try {
			let pageCursor = cursor;
			let followUps = 0;
			while (request.isCurrent()) {
				let empty = false;
				const nextCursor = await loadMessagePage({
					query: () => deps.query(pageCursor, limit),
					isCurrent: request.isCurrent,
					getLoadedMessages: deps.getLoadedMessages,
					getFileLinkVersion: deps.getFileLinkVersion,
					applyLatestMessagePage: reconcile
						? (page) => {
								const reconciled = request.reconcile(page);
								empty = reconciled.length === 0;
								deps.applyLatestMessagePage(reconciled);
							}
						: undefined,
					addMessages: (page) => deps.addMessages(page, pageCursor !== null),
					refreshFileAccessTokens: deps.refreshFileAccessTokens,
				});
				if (!request.isCurrent()) break;
				// Retain progress even if the next fetch fails. The empty-list button
				// can continue from here after a failure or the automatic fetch cap.
				deps.setCursor(nextCursor);
				deps.setHasMore(nextCursor !== null);
				if (!empty || nextCursor === null || followUps >= MAX_EMPTY_PAGE_FOLLOW_UPS) break;
				pageCursor = nextCursor;
				followUps += 1;
			}
		} catch (error) {
			if (request.isCurrent()) deps.onError(error);
		} finally {
			if (request.isCurrent()) {
				fetching = false;
				deps.setFetching(false);
				deps.setLoading(false);
			}
			stop();
			if (unsubscribe === stop) unsubscribe = undefined;
			request.finish();
		}
	};
	return { channelId: deps.channelId, fetch, invalidate };
};
