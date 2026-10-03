import type { TFile, TJoinedMessage } from '@sharkord/shared';
import type { TMessagesMap } from '../types';

type TFileAccessToken = {
	fileId: number;
	accessToken: string;
};

// The server signs at most this many file IDs per `files.refreshAccessTokens` call.
const FILE_ACCESS_TOKEN_BATCH_SIZE = 100;

// Refresh this long before a token expires. It absorbs client clock skew, and a
// refreshed token still has most of its lifetime left.
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

const getFileIds = (files: TFile[]): number[] => [...new Set(files.map((file) => file.id))];

const getMessageFiles = (messages: TJoinedMessage[]): TFile[] => messages.flatMap((message) => message.files);

// Every attachment in every loaded channel.
const getLoadedFiles = (messagesMap: TMessagesMap): TFile[] => Object.values(messagesMap).flatMap(getMessageFiles);

const getExpiringFileIds = (files: TFile[], now: number): number[] =>
	getFileIds(files.filter((file) => isFileAccessTokenExpiring(file._accessToken, now)));

const chunkFileIds = (fileIds: number[], size = FILE_ACCESS_TOKEN_BATCH_SIZE): number[][] => {
	const chunks: number[][] = [];

	for (let index = 0; index < fileIds.length; index += size) {
		chunks.push(fileIds.slice(index, index + size));
	}

	return chunks;
};

const toTokenMap = (tokens: TFileAccessToken[]) =>
	new Map(tokens.map(({ fileId, accessToken }) => [fileId, accessToken]));

const applyTokenMap = (files: TFile[], tokenByFileId: Map<number, string>): TFile[] => {
	let changed = false;

	const nextFiles = files.map((file) => {
		const accessToken = tokenByFileId.get(file.id);

		if (accessToken === undefined || accessToken === file._accessToken) return file;

		changed = true;

		return { ...file, _accessToken: accessToken };
	});

	return changed ? nextFiles : files;
};

// Sets each returned token on its file. Files the response leaves out (no
// access, or not an attachment) keep their token. Returns the same array when
// nothing changed.
const applyFileAccessTokensToFiles = (files: TFile[], tokens: TFileAccessToken[]): TFile[] =>
	applyTokenMap(files, toTokenMap(tokens));

// Same as applyFileAccessTokensToFiles, over the files of loaded messages.
const applyFileAccessTokens = (messages: TJoinedMessage[], tokens: TFileAccessToken[]): TJoinedMessage[] => {
	const tokenByFileId = toTokenMap(tokens);
	let changed = false;

	const nextMessages = messages.map((message) => {
		const files = applyTokenMap(message.files, tokenByFileId);

		if (files === message.files) return message;

		changed = true;

		return { ...message, files };
	});

	return changed ? nextMessages : messages;
};

export type { TFileAccessToken };
export {
	applyFileAccessTokens,
	applyFileAccessTokensToFiles,
	chunkFileIds,
	FILE_ACCESS_TOKEN_CHECK_INTERVAL_MS,
	getExpiringFileIds,
	getFileAccessTokenExpiry,
	getFileIds,
	getLoadedFiles,
	getMessageFiles,
	isFileAccessTokenExpiring,
};
