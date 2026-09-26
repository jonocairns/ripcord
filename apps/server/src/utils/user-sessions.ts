import { DisconnectCode, type TUserPresenceStatus } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { WebSocket } from 'ws';
import { db } from '../db';
import { users } from '../db/schema';
import { invariant } from './invariant';
import type { Context } from './trpc';
import { blockVoiceRestoreAfterKick, getVoiceKickGuardIdentity } from './voice-kick-guard';

type TTrackedWebSocket = WebSocket & {
	userId?: number;
	token: string;
	clientInstanceId?: string;
	currentVoiceChannelId?: number;
	latestVoiceSessionMutationSeq?: number;
	presenceStatus?: TUserPresenceStatus;
};

// The websocket server registers its client set here so session revocation can
// reach every connection without importing the server module (which imports the
// routers that call it).
let trackedClientsSource: (() => Iterable<WebSocket>) | undefined;

const setTrackedClientsSource = (source: (() => Iterable<WebSocket>) | undefined) => {
	trackedClientsSource = source;
};

const getTrackedClients = (): TTrackedWebSocket[] => {
	if (!trackedClientsSource) return [];
	return Array.from(trackedClientsSource()) as TTrackedWebSocket[];
};

const getOpenUserSockets = (userId: number) =>
	getTrackedClients().filter((client) => client.userId === userId && client.readyState === WebSocket.OPEN);

// Per-user auth state used to re-validate long-lived websocket contexts. The
// context is built once per connection, so without this a ban or credential
// change would only take effect when the socket reconnects. Voice signaling is
// chatty, so lookups are cached briefly and invalidated on every write path
// that changes `banned` or `tokenVersion`.
const USER_AUTH_STATE_TTL_MS = 5_000;

type TUserAuthState = {
	banned: boolean;
	tokenVersion: number;
};

type TUserAuthStateEntry = {
	state: TUserAuthState | undefined;
	expiresAt: number;
};

const userAuthStateCache = new Map<number, TUserAuthStateEntry>();
// Bumped on invalidation so a lookup that started before a write cannot store
// the pre-write row after the invalidation ran.
const userAuthStateGenerations = new Map<number, number>();

const invalidateUserAuthState = (userId: number) => {
	userAuthStateCache.delete(userId);
	userAuthStateGenerations.set(userId, (userAuthStateGenerations.get(userId) ?? 0) + 1);
};

const getUserAuthState = async (userId: number): Promise<TUserAuthState | undefined> => {
	const cached = userAuthStateCache.get(userId);

	if (cached && cached.expiresAt > Date.now()) {
		return cached.state;
	}

	const generation = userAuthStateGenerations.get(userId) ?? 0;
	const row = await db
		.select({ banned: users.banned, tokenVersion: users.tokenVersion })
		.from(users)
		.where(eq(users.id, userId))
		.get();

	if ((userAuthStateGenerations.get(userId) ?? 0) === generation) {
		userAuthStateCache.set(userId, {
			state: row,
			expiresAt: Date.now() + USER_AUTH_STATE_TTL_MS,
		});
	}

	return row;
};

// Rejects a connection whose user was deleted or banned, or whose token was
// issued before the user's current tokenVersion (password or 2FA change,
// owner reset).
const assertSessionIsValid = async (userId: number, sessionTokenVersion: number) => {
	const state = await getUserAuthState(userId);

	invariant(state && state.tokenVersion === sessionTokenVersion, {
		code: 'UNAUTHORIZED',
		message: 'Your session is no longer valid. Please sign in again.',
	});

	invariant(!state.banned, {
		code: 'FORBIDDEN',
		message: 'User is banned',
	});
};

// WebSocket close reasons are limited to 123 bytes of UTF-8; `ws` throws on
// anything longer, which would abort the revocation part-way.
const MAX_CLOSE_REASON_BYTES = 123;

const truncateCloseReason = (reason: string | undefined) => {
	if (!reason) return undefined;

	const encoder = new TextEncoder();

	if (encoder.encode(reason).byteLength <= MAX_CLOSE_REASON_BYTES) {
		return reason;
	}

	let truncated = '';

	for (const char of reason) {
		if (encoder.encode(truncated + char).byteLength > MAX_CLOSE_REASON_BYTES) break;
		truncated += char;
	}

	return truncated;
};

type TRevokeUserSessionsOptions = {
	code: DisconnectCode;
	reason?: string;
	// Keeps the caller's own connection open for self-initiated credential changes.
	exceptWs?: WebSocket;
};

// Closes every open connection for the user. Call it after the DB write that
// caused the revocation so the auth-state cache cannot be repopulated with the
// old row.
const revokeUserSessions = (userId: number, { code, reason, exceptWs }: TRevokeUserSessionsOptions) => {
	invalidateUserAuthState(userId);

	const closeReason = truncateCloseReason(reason);
	let revokedCount = 0;

	for (const client of getOpenUserSockets(userId)) {
		if (client === exceptWs) continue;

		if (code === DisconnectCode.KICKED) {
			// Shipped clients treat the kick code as recoverable; block their voice
			// auto-restore before the close reaches them.
			blockVoiceRestoreAfterKick(userId, getVoiceKickGuardIdentity(client));
		}

		client.close(code, closeReason);
		revokedCount += 1;
	}

	return revokedCount;
};

// For a connection that just rotated its own user's credentials (bumping
// tokenVersion): keep the calling connection usable and revoke every other
// session, which still holds a token for the old version.
const revokeOtherUserSessions = (
	ctx: Pick<Context, 'userId' | 'sessionTokenVersion' | 'getOwnWs'>,
	newTokenVersion: number,
	reason: string,
) => {
	ctx.sessionTokenVersion = newTokenVersion;

	return revokeUserSessions(ctx.userId, {
		code: DisconnectCode.KICKED,
		reason,
		exceptWs: ctx.getOwnWs(),
	});
};

const resetUserSessionsForTests = () => {
	trackedClientsSource = undefined;
	userAuthStateCache.clear();
	userAuthStateGenerations.clear();
};

export {
	assertSessionIsValid,
	getOpenUserSockets,
	getTrackedClients,
	invalidateUserAuthState,
	resetUserSessionsForTests,
	revokeOtherUserSessions,
	revokeUserSessions,
	setTrackedClientsSource,
	type TTrackedWebSocket,
};
