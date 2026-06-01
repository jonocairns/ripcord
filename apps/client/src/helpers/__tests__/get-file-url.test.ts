import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TFile } from '@sharkord/shared';

type TTestRuntimeConfig = {
	source: 'web' | 'desktop';
	serverUrl: string;
	serverHost: string;
	isConfigured: boolean;
	needsSetup: boolean;
};

const DEFAULT_RUNTIME_CONFIG: TTestRuntimeConfig = {
	source: 'web',
	serverUrl: 'https://server.example',
	serverHost: 'server.example',
	isConfigured: true,
	needsSetup: false,
};

let runtimeConfig: TTestRuntimeConfig = DEFAULT_RUNTIME_CONFIG;

mock.module('@/runtime/server-config', () => ({
	getRuntimeServerConfig: () => runtimeConfig,
}));

const originalWindow = (globalThis as { window?: Window }).window;

const installWindowLocation = (href: string): void => {
	Reflect.set(globalThis, 'window', {
		location: new URL(href),
	});
};

const createFile = (overrides: Partial<TFile> = {}): TFile => ({
	id: 42,
	name: 'example.png',
	originalName: 'example.png',
	md5: 'md5',
	userId: 1,
	size: 1024,
	mimeType: 'image/png',
	extension: '.png',
	createdAt: Date.now(),
	updatedAt: null,
	...overrides,
});

describe('get-file-url helpers', () => {
	beforeEach(() => {
		runtimeConfig = { ...DEFAULT_RUNTIME_CONFIG };
		installWindowLocation('https://client.example/app/index.html');
	});

	afterEach(() => {
		if (originalWindow) {
			Reflect.set(globalThis, 'window', originalWindow);
			return;
		}

		Reflect.deleteProperty(globalThis, 'window');
	});

	test('returns an empty URL for missing file data', async () => {
		const { getFileUrl } = await import('../get-file-url');

		expect(getFileUrl(undefined)).toBe('');
		expect(getFileUrl(null)).toBe('');
	});

	test('encodes file names as a path segment and preserves access token query params', async () => {
		const { getFileUrl } = await import('../get-file-url');

		const url = getFileUrl(
			createFile({
				id: 123,
				name: 'résumé final #1?.png',
				_accessToken: 'token+/= value',
			}),
		);

		expect(url).toBe(
			'https://server.example/public/r%C3%A9sum%C3%A9%20final%20%231%3F.png?accessToken=token%2B%2F%3D+value&v=123',
		);
	});

	test('omits access token query params for public files', async () => {
		const { getFileUrl } = await import('../get-file-url');

		const url = getFileUrl(
			createFile({
				id: 456,
				name: 'public file.png',
			}),
		);

		expect(url).toBe('https://server.example/public/public%20file.png?v=456');
	});

	test('uses initialized runtime server config for HTTP origins and websocket hosts', async () => {
		const { getHostFromServer, getUrlFromServer } = await import('../get-file-url');

		runtimeConfig = {
			source: 'desktop',
			serverUrl: 'https://desktop-server.example:9443',
			serverHost: 'desktop-server.example:9443',
			isConfigured: true,
			needsSetup: false,
		};

		expect(getUrlFromServer()).toBe('https://desktop-server.example:9443');
		expect(getHostFromServer()).toBe('desktop-server.example:9443');
	});

	test('resolves public assets for web and packaged desktop renderer origins', async () => {
		const { getPublicAssetUrl } = await import('../get-file-url');

		expect(getPublicAssetUrl('/logo.webp')).toBe('/logo.webp');
		expect(getPublicAssetUrl('sounds/message1.mp3', { absolute: true })).toBe(
			'https://client.example/sounds/message1.mp3',
		);

		installWindowLocation('file:///Applications/Ripcord/resources/app.asar/dist/index.html');

		expect(getPublicAssetUrl('/logo.webp')).toBe('./logo.webp');
		expect(getPublicAssetUrl('sounds/message1.mp3', { absolute: true })).toBe(
			'file:///Applications/Ripcord/resources/app.asar/dist/sounds/message1.mp3',
		);
	});
});
