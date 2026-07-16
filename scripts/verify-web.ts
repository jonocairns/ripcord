#!/usr/bin/env bun
import { type BrowserContext, chromium, type Page } from 'playwright';

type Scenario = 'voice' | 'reconnect' | 'screenshare';

interface Options {
	baseUrl: string;
	channel: string;
	headed: boolean;
	scenario: Scenario;
	serverUrl: string;
}

interface Account {
	displayName: string;
	identity: string;
	password: string;
}

function parseArgs(args: string[]): Options {
	let baseUrl = 'http://127.0.0.1:5173';
	let channel = 'Lounge';
	let headed = false;
	let scenario: Scenario = 'voice';
	let serverUrl = 'http://127.0.0.1:4991';

	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === '--base-url') {
			baseUrl = args[++index] ?? baseUrl;
		} else if (argument === '--server-url') {
			serverUrl = args[++index] ?? serverUrl;
		} else if (argument === '--channel') {
			channel = args[++index] ?? channel;
		} else if (argument === '--headed') {
			headed = true;
		} else if (argument === '--scenario') {
			const value = args[++index];
			if (value !== 'voice' && value !== 'reconnect' && value !== 'screenshare') {
				throw new Error('--scenario must be voice, reconnect, or screenshare');
			}
			scenario = value;
		} else if (argument === '--help') {
			console.log(`Usage: bun run verify:web [options]

Options:
  --scenario voice|reconnect|screenshare  Runtime flow to exercise (default: voice)
  --base-url URL                           Running client URL (default: http://127.0.0.1:5173)
  --server-url URL                         Running server URL (default: http://127.0.0.1:4991)
  --channel NAME                          Voice channel to use (default: Lounge)
  --headed                                Show the browser window

Accounts can be overridden with RIPCORD_VERIFY_IDENTITY, RIPCORD_VERIFY_PASSWORD,
RIPCORD_VERIFY_DISPLAY_NAME, and corresponding RIPCORD_VERIFY_PEER_* variables.`);
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}

	return { baseUrl, channel, headed, scenario, serverUrl };
}

function accountFromEnvironment(prefix: '' | 'PEER_'): Account {
	const environmentPrefix = `RIPCORD_VERIFY_${prefix}`;
	return {
		identity: process.env[`${environmentPrefix}IDENTITY`] ?? (prefix ? 'e2e-peer-b' : 'claude'),
		password: process.env[`${environmentPrefix}PASSWORD`] ?? 'claude',
		displayName: process.env[`${environmentPrefix}DISPLAY_NAME`] ?? (prefix ? 'E2E Peer B' : 'SharkordUser'),
	};
}

function attachDiagnostics(page: Page, label: string): void {
	page.on('console', (message) => {
		console.log(`[${label}:console:${message.type()}] ${message.text()}`);
	});
	page.on('pageerror', (error) => {
		console.error(`[${label}:pageerror] ${error.stack ?? error.message}`);
	});
	page.on('requestfailed', (request) => {
		console.error(
			`[${label}:requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
		);
	});
}

function isAuthResponse(value: unknown): value is { token: string; refreshToken: string } {
	if (typeof value !== 'object' || value === null) return false;
	return (
		'token' in value &&
		typeof value.token === 'string' &&
		'refreshToken' in value &&
		typeof value.refreshToken === 'string'
	);
}

async function login(page: Page, baseUrl: string, serverUrl: string, channel: string, account: Account): Promise<void> {
	await page.goto(baseUrl);
	const loginResponse = await page.request.post(`${serverUrl.replace(/\/$/, '')}/login`, {
		data: { identity: account.identity, password: account.password },
	});
	const loginBody: unknown = await loginResponse.json();
	if (!loginResponse.ok() || !isAuthResponse(loginBody)) {
		throw new Error(`Login failed with HTTP ${loginResponse.status()}`);
	}
	await page.evaluate(
		({ identity, refreshToken, token }) => {
			localStorage.setItem('sharkord-auth-token', token);
			localStorage.setItem('sharkord-refresh-token', refreshToken);
			localStorage.setItem('sharkord-identity', identity);
			sessionStorage.setItem('sharkord-token', token);
		},
		{ identity: account.identity, refreshToken: loginBody.refreshToken, token: loginBody.token },
	);
	await page.reload();
	try {
		await page.getByText(channel, { exact: true }).first().waitFor({ state: 'visible' });
	} catch (error) {
		const toasts = await page.locator('[data-sonner-toast]').allTextContents();
		const visibleText = (await page.locator('body').innerText()).replaceAll(/\s+/g, ' ').slice(0, 500);
		throw new Error(
			`Login did not reach channel ${JSON.stringify(channel)}. Toasts: ${JSON.stringify(toasts)}. Visible text: ${JSON.stringify(visibleText)}`,
			{ cause: error },
		);
	}
}

async function joinVoice(page: Page, channel: string): Promise<void> {
	await page.getByText(channel, { exact: true }).first().click({ force: true });
	await page.getByTitle('Leave voice').waitFor({ state: 'visible' });
}

async function leaveVoice(page: Page): Promise<void> {
	const leaveButton = page.getByTitle('Leave voice');
	if (await leaveButton.isVisible()) {
		await leaveButton.click();
		await leaveButton.waitFor({ state: 'hidden' });
	}
}

async function verifyVoice(page: Page, channel: string): Promise<void> {
	await joinVoice(page, channel);
	await page.getByTitle('Mute microphone').click();
	await page.getByTitle('Unmute microphone').waitFor({ state: 'visible' });
	await page.getByTitle('Unmute microphone').click();
	await page.getByTitle('Mute microphone').waitFor({ state: 'visible' });
}

async function verifyReconnect(page: Page, channel: string): Promise<void> {
	await joinVoice(page, channel);
	await page.getByRole('button', { name: 'Open reconnect lab' }).click();
	await page.getByRole('button', { name: 'Drop WS (<60s)', exact: true }).click();
	await page.getByText(/Socket connected · voice #\d+/).waitFor({ state: 'visible', timeout: 30_000 });
	await page.getByTitle('Leave voice').waitFor({ state: 'visible' });
}

async function verifyScreenshare(
	primary: Page,
	observer: Page,
	channel: string,
	primaryAccount: Account,
): Promise<void> {
	await joinVoice(primary, channel);
	await joinVoice(observer, channel);
	await primary.getByTitle('Share screen').click();
	await primary.getByTitle('Stop sharing').waitFor({ state: 'visible' });

	const participant = observer.getByText(primaryAccount.displayName, { exact: true }).first();
	await participant.waitFor({ state: 'visible' });
	const participantRow = participant.locator('xpath=..');
	await participantRow.locator('button:has(.lucide-monitor)').click();
	const watchButton = observer.getByRole('button', { name: 'Watch', exact: true });
	if (await watchButton.isVisible()) await watchButton.click();
	await observer.locator('video').first().waitFor({ state: 'visible' });

	await primary.getByTitle('Stop sharing').click();
	await primary.getByTitle('Share screen').waitFor({ state: 'visible' });
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const primaryAccount = accountFromEnvironment('');
	const peerAccount = accountFromEnvironment('PEER_');
	const browser = await chromium.launch({
		channel: 'chromium',
		headless: !options.headed,
		args: [
			'--use-fake-ui-for-media-stream',
			'--use-fake-device-for-media-stream',
			'--auto-select-desktop-capture-source=Entire screen',
		],
	});
	const contexts: BrowserContext[] = [];

	try {
		const primaryContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
		contexts.push(primaryContext);
		const primary = await primaryContext.newPage();
		attachDiagnostics(primary, 'primary');
		await login(primary, options.baseUrl, options.serverUrl, options.channel, primaryAccount);

		if (options.scenario === 'voice') {
			await verifyVoice(primary, options.channel);
		} else if (options.scenario === 'reconnect') {
			await verifyReconnect(primary, options.channel);
		} else {
			const peerContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
			contexts.push(peerContext);
			const observer = await peerContext.newPage();
			attachDiagnostics(observer, 'observer');
			await login(observer, options.baseUrl, options.serverUrl, options.channel, peerAccount);
			await verifyScreenshare(primary, observer, options.channel, primaryAccount);
			await leaveVoice(observer);
		}

		await leaveVoice(primary);
		console.log(`Verification passed: ${options.scenario}`);
	} finally {
		for (const context of contexts.reverse()) await context.close();
		await browser.close();
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
}
