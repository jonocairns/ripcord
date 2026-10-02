import { describe, expect, it } from 'bun:test';
import type { TFile, TJoinedMessage } from '@sharkord/shared';
import {
	applyFileAccessTokens,
	chunkFileIds,
	getChannelIdsWithExpiringFileTokens,
	getChannelIdsWithLoadedFiles,
	getFileAccessTokenExpiry,
	getMessageFileIds,
	isFileAccessTokenExpiring,
} from '../file-access-tokens';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 2, 12);
// Every token the server issues today: a bare HMAC with no expiry prefix.
const LEGACY_TOKEN = 'a'.repeat(64);

const expiringToken = (expiresAt: number) => `${Math.floor(expiresAt / 1000)}.${'b'.repeat(64)}`;

const createFile = (id: number, accessToken?: string): TFile =>
	({
		id,
		name: `file-${id}.png`,
		originalName: `file-${id}.png`,
		extension: '.png',
		...(accessToken !== undefined ? { _accessToken: accessToken } : {}),
	}) as unknown as TFile;

const createMessage = (id: number, files: TFile[]): TJoinedMessage =>
	({
		id,
		channelId: 1,
		userId: 1,
		content: '',
		createdAt: id,
		updatedAt: id,
		files,
		reactions: [],
	}) as unknown as TJoinedMessage;

describe('getFileAccessTokenExpiry', () => {
	it('reads the exp prefix in milliseconds', () => {
		expect(getFileAccessTokenExpiry(`1790000000.${'c'.repeat(64)}`)).toBe(1_790_000_000_000);
	});

	it('treats tokens without an exp prefix as never expiring', () => {
		expect(getFileAccessTokenExpiry(LEGACY_TOKEN)).toBeUndefined();
		expect(getFileAccessTokenExpiry(undefined)).toBeUndefined();
		expect(getFileAccessTokenExpiry(`.${LEGACY_TOKEN}`)).toBeUndefined();
		expect(getFileAccessTokenExpiry(`12ab.${LEGACY_TOKEN}`)).toBeUndefined();
	});
});

describe('isFileAccessTokenExpiring', () => {
	it('never refreshes a token without exp', () => {
		expect(isFileAccessTokenExpiring(LEGACY_TOKEN, NOW)).toBe(false);
		expect(isFileAccessTokenExpiring(undefined, NOW)).toBe(false);
	});

	it('refreshes a token expiring within 12 hours', () => {
		expect(isFileAccessTokenExpiring(expiringToken(NOW + 11 * HOUR_MS), NOW)).toBe(true);
		expect(isFileAccessTokenExpiring(expiringToken(NOW + 12 * HOUR_MS), NOW)).toBe(true);
		expect(isFileAccessTokenExpiring(expiringToken(NOW - HOUR_MS), NOW)).toBe(true);
	});

	it('leaves a token with more than 12 hours left', () => {
		expect(isFileAccessTokenExpiring(expiringToken(NOW + 13 * HOUR_MS), NOW)).toBe(false);
	});
});

describe('getChannelIdsWithExpiringFileTokens', () => {
	it('selects only channels holding a token close to expiry', () => {
		const messagesMap = {
			1: [createMessage(1, [createFile(1, expiringToken(NOW + HOUR_MS))])],
			2: [createMessage(2, [createFile(2, expiringToken(NOW + 30 * HOUR_MS))])],
			3: [createMessage(3, [createFile(3, LEGACY_TOKEN), createFile(4)])],
		};

		expect(getChannelIdsWithExpiringFileTokens(messagesMap, NOW)).toEqual([1]);
	});
});

describe('getChannelIdsWithLoadedFiles', () => {
	it('skips channels with no loaded messages or no files', () => {
		const messagesMap = {
			1: [createMessage(1, [createFile(1)])],
			2: [],
			3: [createMessage(2, [])],
		};

		expect(getChannelIdsWithLoadedFiles(messagesMap)).toEqual([1]);
	});
});

describe('getMessageFileIds', () => {
	it('returns every file ID once, tokened or not', () => {
		const messages = [
			createMessage(1, [createFile(1, LEGACY_TOKEN), createFile(2)]),
			createMessage(2, [createFile(2), createFile(3)]),
		];

		expect(getMessageFileIds(messages)).toEqual([1, 2, 3]);
	});
});

describe('chunkFileIds', () => {
	it('splits IDs into batches the server accepts', () => {
		const fileIds = Array.from({ length: 250 }, (_, index) => index + 1);
		const chunks = chunkFileIds(fileIds);

		expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
		expect(chunks.flat()).toEqual(fileIds);
	});
});

describe('applyFileAccessTokens', () => {
	it('sets returned tokens and clears requested files the response leaves out', () => {
		const messages = [
			createMessage(1, [createFile(1, 'old-1'), createFile(2, 'old-2')]),
			createMessage(2, [createFile(3)]),
		];

		const result = applyFileAccessTokens(
			messages,
			[1, 2, 3],
			[
				{ fileId: 1, accessToken: 'new-1' },
				{ fileId: 3, accessToken: 'new-3' },
			],
		);

		expect(result[0]?.files[0]?._accessToken).toBe('new-1');
		expect(result[0]?.files[1]).not.toHaveProperty('_accessToken');
		expect(result[1]?.files[0]?._accessToken).toBe('new-3');
	});

	it('leaves files that were not requested alone', () => {
		const untouched = createMessage(2, [createFile(3, 'keep-3')]);
		const messages = [createMessage(1, [createFile(1, 'old-1'), createFile(2, 'keep-2')]), untouched];

		const result = applyFileAccessTokens(messages, [1], []);

		expect(result[0]?.files[0]).not.toHaveProperty('_accessToken');
		expect(result[0]?.files[1]?._accessToken).toBe('keep-2');
		expect(result[1]).toBe(untouched);
	});

	it('returns the same array when nothing changed', () => {
		const messages = [createMessage(1, [createFile(1, 'same'), createFile(2)])];

		expect(applyFileAccessTokens(messages, [1, 2], [{ fileId: 1, accessToken: 'same' }])).toBe(messages);
	});
});
