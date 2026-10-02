import type { TFile, TJoinedMessage } from '@sharkord/shared';
import type { TMessagesMap } from '../types';

type TFileAccessToken = {
	fileId: number;
	accessToken: string;
};

// The server signs at most this many file IDs per `files.getAccessTokens` call.
const FILE_ACCESS_TOKEN_BATCH_SIZE = 100;

// Refresh this long before a token expires. It absorbs client clock skew, and a
// refreshed token still has at least 24 hours left.
const FILE_ACCESS_TOKEN_REFRESH_THRESHOLD_MS = 12 * 60 * 60 * 1000;

// How often an open session checks loaded tokens for an upcoming expiry.
const FILE_ACCESS_TOKEN_CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Expiring tokens look like `<exp>.<hmac>`, with `exp` in Unix seconds. Tokens
// without that prefix (every token issued before expiry ships) never expire.
const getFileAccessTokenExpiry = (accessToken: string | undefined): number | undefined => {
	if (!accessToken) return undefined;

	const separatorIndex = accessToken.indexOf('.');

	if (separatorIndex <= 0) return undefined;

	const exp = accessToken.slice(0, separatorIndex);

	if (!/^\d+$/.test(exp)) return undefined;

	return Number(exp) * 1000;
};

const isFileAccessTokenExpiring = (
	accessToken: string | undefined,
	now: number,
	thresholdMs = FILE_ACCESS_TOKEN_REFRESH_THRESHOLD_MS,
): boolean => {
	const expiresAt = getFileAccessTokenExpiry(accessToken);

	return expiresAt !== undefined && expiresAt - now <= thresholdMs;
};

const hasExpiringFileAccessToken = (files: TFile[], now: number): boolean =>
	files.some((file) => isFileAccessTokenExpiring(file._accessToken, now));

// Every file in the loaded messages, tokened or not, so a channel that just
// went private gets tokens for files loaded while it was public.
const getMessageFileIds = (messages: TJoinedMessage[]): number[] => {
	const fileIds = new Set<number>();

	for (const message of messages) {
		for (const file of message.files) {
			fileIds.add(file.id);
		}
	}

	return [...fileIds];
};

const getChannelIdsWithLoadedFiles = (messagesMap: TMessagesMap): number[] =>
	Object.entries(messagesMap)
		.filter(([, messages]) => messages.some((message) => message.files.length > 0))
		.map(([channelId]) => Number(channelId));

const getChannelIdsWithExpiringFileTokens = (messagesMap: TMessagesMap, now: number): number[] =>
	Object.entries(messagesMap)
		.filter(([, messages]) => messages.some((message) => hasExpiringFileAccessToken(message.files, now)))
		.map(([channelId]) => Number(channelId));

const chunkFileIds = (fileIds: number[], size = FILE_ACCESS_TOKEN_BATCH_SIZE): number[][] => {
	const chunks: number[][] = [];

	for (let index = 0; index < fileIds.length; index += size) {
		chunks.push(fileIds.slice(index, index + size));
	}

	return chunks;
};

// Sets the returned token on each requested file, and clears `_accessToken` on
// requested files the response leaves out (the channel went public, or the
// file is gone). Files that were not requested keep their token. Returns the
// same array when nothing changed.
const applyFileAccessTokens = (
	messages: TJoinedMessage[],
	requestedFileIds: number[],
	tokens: TFileAccessToken[],
): TJoinedMessage[] => {
	const requested = new Set(requestedFileIds);
	const tokenByFileId = new Map(tokens.map(({ fileId, accessToken }) => [fileId, accessToken]));
	let changed = false;

	const nextMessages = messages.map((message) => {
		let messageChanged = false;

		const files = message.files.map((file) => {
			if (!requested.has(file.id)) return file;

			const accessToken = tokenByFileId.get(file.id);

			if (accessToken === file._accessToken) return file;

			messageChanged = true;

			if (accessToken === undefined) {
				const { _accessToken: _removedToken, ...fileWithoutToken } = file;

				return fileWithoutToken;
			}

			return { ...file, _accessToken: accessToken };
		});

		if (!messageChanged) return message;

		changed = true;

		return { ...message, files };
	});

	return changed ? nextMessages : messages;
};

export type { TFileAccessToken };
export {
	applyFileAccessTokens,
	chunkFileIds,
	FILE_ACCESS_TOKEN_CHECK_INTERVAL_MS,
	getChannelIdsWithExpiringFileTokens,
	getChannelIdsWithLoadedFiles,
	getFileAccessTokenExpiry,
	getMessageFileIds,
	hasExpiringFileAccessToken,
	isFileAccessTokenExpiring,
};
