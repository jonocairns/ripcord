import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { credentialsFor, disposePeer, login } from '../helpers/app';

const LOG_PATH = path.resolve(import.meta.dirname, '../.runtime/data/logs/app.log');
const readProbeRecords = async (marker: string) => {
	const content = await fs.readFile(LOG_PATH, 'utf8');
	return content.split('\n').flatMap((line) => {
		if (!line.trim()) return [];
		const record: unknown = JSON.parse(line);
		return record &&
			typeof record === 'object' &&
			'message' in record &&
			typeof record.message === 'string' &&
			record.message.startsWith(marker)
			? [record]
			: [];
	});
};

test('without a provider, browser errors reach server logs without external SDK uploads', async ({
	browser,
}, testInfo) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const credentials = credentialsFor(testInfo);
	const providerRequests: string[] = [];
	context.on('request', (request) => {
		if (new URL(request.url()).pathname.includes('/envelope/')) providerRequests.push(request.url());
	});
	const marker = `E2E diagnostic ${crypto.randomUUID()}`;
	try {
		await login(page, credentials);
		await page.evaluate(async (marker) => {
			const modulePath = '/src/helpers/browser-logger.ts';
			const logger: unknown = await import(modulePath);
			if (
				!logger ||
				typeof logger !== 'object' ||
				!('reportError' in logger) ||
				typeof logger.reportError !== 'function'
			)
				throw new Error('Error reporter unavailable');
			logger.reportError(`${marker} explicit`, new TypeError(`${marker} explicit`), {
				password: 'fake-private-password',
			});
			console.error(`${marker} console`);
		}, marker);
		await expect.poll(() => readProbeRecords(marker)).toHaveLength(2);
		const records = await readProbeRecords(marker);
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: 'client',
					kind: 'exception',
					level: 'error',
					runtime: 'web',
					message: `${marker} explicit`,
					context: { password: '[redacted]' },
					exception: expect.objectContaining({ type: 'TypeError' }),
				}),
				expect.objectContaining({ source: 'client', level: 'error', message: `${marker} console` }),
			]),
		);
		await page.evaluate(async () => {
			const modulePath = '/src/features/server/actions.ts';
			const actions: unknown = await import(modulePath);
			if (
				!actions ||
				typeof actions !== 'object' ||
				!('logoutFromServer' in actions) ||
				typeof actions.logoutFromServer !== 'function'
			)
				throw new Error('Logout action unavailable');
			await actions.logoutFromServer();
		});
		expect(providerRequests).toEqual([]);
	} finally {
		await disposePeer({ context, page, credentials });
	}
});
