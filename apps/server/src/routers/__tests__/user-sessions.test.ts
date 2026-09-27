import { afterEach, describe, expect, test } from 'bun:test';
import { DisconnectCode } from '@sharkord/shared';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { and, eq, isNull } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { WebSocket, WebSocketServer } from 'ws';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken, initTest, refresh, uploadFile } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { refreshTokens, users } from '../../db/schema';
import { issueAuthTokens } from '../../http/auth-tokens';
import { appRouter } from '../../routers';
import { setTrackedClientsSource } from '../../utils/user-sessions';
import { isVoiceRestoreBlockedAfterKick, resetVoiceKickGuardsForTests } from '../../utils/voice-kick-guard';

// Matches the clientInstanceId createMockContext gives every test connection,
// so a fake socket with this id and the caller's token is that caller's own ws.
const TEST_CLIENT_INSTANCE_ID = 'test-client-instance';

type TCloseCall = { code: number; reason?: string };

type TFakeSocket = {
	userId: number;
	token: string;
	clientInstanceId: string;
	readyState: number;
	closeCalls: TCloseCall[];
	close: (code: number, reason?: string) => void;
};

const createFakeSocket = (
	userId: number,
	clientInstanceId: string,
	opts?: { token?: string; readyState?: number },
): TFakeSocket => {
	const socket: TFakeSocket = {
		userId,
		token: opts?.token ?? `token-${clientInstanceId}`,
		clientInstanceId,
		readyState: opts?.readyState ?? WebSocket.OPEN,
		closeCalls: [],
		close: (code, reason) => {
			socket.closeCalls.push({ code, reason });
			socket.readyState = WebSocket.CLOSING;
		},
	};

	return socket;
};

const trackSockets = (sockets: TFakeSocket[]) => {
	// Test-only partial mock: revocation only reads the tracked fields and close().
	setTrackedClientsSource(() => sockets as unknown as WebSocket[]);
};

afterEach(() => {
	resetVoiceKickGuardsForTests();
});

describe('user session revocation', () => {
	test('ban closes every connection of the user and rejects further calls on them', async () => {
		const { caller: ownerCaller } = await initTest(1);
		const { caller: desktopCaller } = await initTest(2);
		const { caller: webCaller } = await initTest(2);
		const desktopSocket = createFakeSocket(2, 'desktop');
		const webSocket = createFakeSocket(2, 'web');
		const bystanderSocket = createFakeSocket(3, 'bystander');

		trackSockets([desktopSocket, webSocket, bystanderSocket]);

		await ownerCaller.users.ban({ userId: 2, reason: 'Spam' });

		expect(desktopSocket.closeCalls).toEqual([{ code: DisconnectCode.BANNED, reason: 'Spam' }]);
		expect(webSocket.closeCalls).toEqual([{ code: DisconnectCode.BANNED, reason: 'Spam' }]);
		expect(bystanderSocket.closeCalls).toEqual([]);

		await expect(desktopCaller.users.totpStatus()).rejects.toThrow('User is banned');
		await expect(webCaller.users.totpStatus()).rejects.toThrow('User is banned');
	});

	test('unban restores access for a connection that was rejected while banned', async () => {
		const { caller: ownerCaller } = await initTest(1);
		const { caller: targetCaller } = await initTest(2);

		await ownerCaller.users.ban({ userId: 2 });
		await expect(targetCaller.users.totpStatus()).rejects.toThrow('User is banned');

		await ownerCaller.users.unban({ userId: 2 });

		await expect(targetCaller.users.totpStatus()).resolves.toEqual({ enabled: false });
	});

	test('a connection opened before a ban cannot join after it', async () => {
		const { caller: ownerCaller } = await initTest(1);
		const pendingCaller = appRouter.createCaller(await createMockContext({ customToken: await getMockedToken(2) }));
		const { handshakeHash } = await pendingCaller.others.handshake();

		await ownerCaller.users.ban({ userId: 2 });

		await expect(pendingCaller.others.joinServer({ handshakeHash })).rejects.toThrow('User is banned');
	});

	test('ban truncates a long reason to the websocket close-frame limit', async () => {
		const { caller: ownerCaller } = await initTest(1);
		const targetSocket = createFakeSocket(2, 'desktop');
		const reason = 'é'.repeat(100);

		trackSockets([targetSocket]);

		await ownerCaller.users.ban({ userId: 2, reason });

		const closeReason = targetSocket.closeCalls[0]?.reason ?? '';

		expect(new TextEncoder().encode(closeReason).byteLength).toBeLessThanOrEqual(123);
		expect(reason.startsWith(closeReason)).toBe(true);
	});

	test('password change revokes the other sessions and keeps the caller connected', async () => {
		const { caller: ownCaller, mockedToken } = await initTest(1);
		const { caller: otherCaller } = await initTest(1);
		const ownSocket = createFakeSocket(1, TEST_CLIENT_INSTANCE_ID, { token: mockedToken });
		const otherSocket = createFakeSocket(1, 'other-device');

		trackSockets([ownSocket, otherSocket]);

		const result = await ownCaller.users.updatePassword({
			currentPassword: 'password123',
			newPassword: 'newpassword123',
			confirmNewPassword: 'newpassword123',
		});

		expect(result).toBeUndefined();
		expect(ownSocket.closeCalls).toEqual([]);
		expect(otherSocket.closeCalls).toEqual([
			{ code: DisconnectCode.KICKED, reason: 'Your password was changed. Please sign in again.' },
		]);

		await expect(ownCaller.users.totpStatus()).resolves.toEqual({ enabled: false });
		await expect(otherCaller.users.totpStatus()).rejects.toThrow('Your session is no longer valid');
	});

	test('enabling 2FA revokes the other sessions and keeps the caller connected', async () => {
		const { caller: ownCaller, mockedToken } = await initTest(1);
		const { caller: otherCaller } = await initTest(1);
		const ownSocket = createFakeSocket(1, TEST_CLIENT_INSTANCE_ID, { token: mockedToken });
		const otherSocket = createFakeSocket(1, 'other-device');

		trackSockets([ownSocket, otherSocket]);

		const setup = await ownCaller.users.totpGenerateSetup({ password: 'password123' });
		const code = new TOTP({ secret: Secret.fromBase32(setup.secret), digits: 6, period: 30 }).generate();

		await ownCaller.users.totpConfirmSetup({ setupToken: setup.setupToken, code, renewSession: true });

		expect(ownSocket.closeCalls).toEqual([]);
		expect(otherSocket.closeCalls.map((call) => call.code)).toEqual([DisconnectCode.KICKED]);

		await expect(ownCaller.users.totpStatus()).resolves.toEqual({ enabled: true });
		await expect(otherCaller.users.totpStatus()).rejects.toThrow('Your session is no longer valid');
	});

	test('enabling 2FA renews HTTP credentials while revoking old access and refresh tokens', async () => {
		const { caller } = await initTest(1);
		const previousTokens = await issueAuthTokens(1, 0);
		const setup = await caller.users.totpGenerateSetup({ password: 'password123' });
		const code = new TOTP({ secret: Secret.fromBase32(setup.secret), digits: 6, period: 30 }).generate();
		const renewedTokens = await caller.users.totpConfirmSetup({
			setupToken: setup.setupToken,
			code,
			renewSession: true,
		});
		if (!renewedTokens.token || !renewedTokens.refreshToken) throw new Error('Expected renewed credentials');
		const file = new File(['upload remains usable'], 'session.txt');

		expect((await uploadFile(file, previousTokens.token)).status).toBe(401);
		expect((await refresh(previousTokens.refreshToken)).status).toBe(401);
		expect((await uploadFile(file, renewedTokens.token)).status).toBe(200);
		expect((await refresh(renewedTokens.refreshToken)).status).toBe(200);
		await expect(caller.users.totpStatus()).resolves.toEqual({ enabled: true });
	});

	test('a credential rotation during token issuance cannot create a surviving refresh token', async () => {
		const pendingTokens = issueAuthTokens(1, 0);
		// Synchronous update occurs while signing/hashing is awaiting.
		tdb.update(users).set({ tokenVersion: 1 }).where(eq(users.id, 1)).run();
		await expect(pendingTokens).rejects.toThrow('Your session is no longer valid');
		expect(await tdb.select().from(refreshTokens).where(eq(refreshTokens.userId, 1))).toEqual([]);
	});

	test('password change renews caller HTTP credentials only when requested', async () => {
		const { caller } = await initTest(1);
		const previous = await issueAuthTokens(1, 0);
		const renewed = await caller.users.updatePassword({
			currentPassword: 'password123',
			newPassword: 'newpassword123',
			confirmNewPassword: 'newpassword123',
			renewSession: true,
		});
		if (!renewed) throw new Error('Expected renewed credentials');
		const file = new File(['password changed'], 'session.txt');
		expect((await uploadFile(file, previous.token)).status).toBe(401);
		expect((await refresh(previous.refreshToken)).status).toBe(401);
		expect((await uploadFile(file, renewed.token)).status).toBe(200);
		expect((await refresh(renewed.refreshToken)).status).toBe(200);
		await expect(caller.users.totpStatus()).resolves.toEqual({ enabled: false });
	});

	test('disabling 2FA renews caller HTTP credentials and revokes older credentials', async () => {
		const { caller } = await initTest(1);
		const setup = await caller.users.totpGenerateSetup({ password: 'password123' });
		const totp = new TOTP({ secret: Secret.fromBase32(setup.secret), digits: 6, period: 30 });
		const enabled = await caller.users.totpConfirmSetup({
			setupToken: setup.setupToken,
			code: totp.generate(),
			renewSession: true,
		});
		if (!enabled.token || !enabled.refreshToken) throw new Error('Expected renewed credentials');
		// The adjacent accepted time step avoids replaying the setup code.
		const renewed = await caller.users.totpDisable({
			password: 'password123',
			code: totp.generate({ timestamp: Date.now() + 30_000 }),
			renewSession: true,
		});
		if (!renewed.token || !renewed.refreshToken) throw new Error('Expected renewed credentials');
		const file = new File(['2FA disabled'], 'session.txt');
		expect((await uploadFile(file, enabled.token)).status).toBe(401);
		expect((await refresh(enabled.refreshToken)).status).toBe(401);
		expect((await uploadFile(file, renewed.token)).status).toBe(200);
		expect((await refresh(renewed.refreshToken)).status).toBe(200);
		await expect(caller.users.totpStatus()).resolves.toEqual({ enabled: false });
	});

	test('legacy 2FA setup clients are closed for reauthentication after success', async () => {
		const { caller, mockedToken } = await initTest(1);
		const ownSocket = createFakeSocket(1, TEST_CLIENT_INSTANCE_ID, { token: mockedToken });
		trackSockets([ownSocket]);
		const setup = await caller.users.totpGenerateSetup({ password: 'password123' });
		const code = new TOTP({ secret: Secret.fromBase32(setup.secret), digits: 6, period: 30 }).generate();
		const result = await caller.users.totpConfirmSetup({ setupToken: setup.setupToken, code });
		expect(result).toEqual({ success: true });
		expect(
			await tdb
				.select()
				.from(refreshTokens)
				.where(and(eq(refreshTokens.userId, 1), isNull(refreshTokens.revokedAt))),
		).toEqual([]);
		await Bun.sleep(5);
		expect(ownSocket.closeCalls.map((call) => call.code)).toEqual([DisconnectCode.KICKED]);
		await expect(caller.users.totpStatus()).rejects.toThrow('Your session is no longer valid');
	});

	test('legacy 2FA setup queues its success over real WebSocket transport before closing', async () => {
		const token = await getMockedToken(1);
		const ctx = await createMockContext({ customToken: token });
		const caller = appRouter.createCaller(ctx);
		const { handshakeHash } = await caller.others.handshake();
		await caller.others.joinServer({ handshakeHash });
		const setup = await caller.users.totpGenerateSetup({ password: 'password123' });
		const wss = new WebSocketServer({ port: 0 });
		applyWSSHandler({ wss, router: appRouter, createContext: async () => ctx });
		if (!wss.address()) await new Promise<void>((resolve) => wss.once('listening', resolve));
		const address = wss.address();
		if (!address || typeof address === 'string') throw new Error('Missing WebSocket port');
		const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
		const received: unknown[] = [];
		try {
			const closed = new Promise<number>((resolve, reject) => {
				client.on('message', (message) => received.push(JSON.parse(message.toString())));
				client.once('close', (code) => resolve(code));
				client.once('error', reject);
			});
			await new Promise<void>((resolve) => client.once('open', resolve));
			setTrackedClientsSource(() =>
				Array.from(wss.clients, (socket) =>
					Object.assign(socket, {
						userId: 1,
						token,
						clientInstanceId: TEST_CLIENT_INSTANCE_ID,
					}),
				),
			);
			client.send(
				JSON.stringify({
					id: 1,
					method: 'mutation',
					params: {
						path: 'users.totpConfirmSetup',
						input: {
							setupToken: setup.setupToken,
							code: new TOTP({ secret: Secret.fromBase32(setup.secret), digits: 6, period: 30 }).generate(),
						},
					},
				}),
			);
			expect(await closed).toBe(DisconnectCode.KICKED);
			expect(received).toContainEqual({ id: 1, result: { type: 'data', data: { success: true } } });
		} finally {
			client.terminate();
			wss.close();
		}
	});

	test('a successful forced password change unblocks the retained context', async () => {
		await tdb.update(users).set({ mustChangePassword: true }).where(eq(users.id, 1));
		const { caller } = await initTest(1);
		await expect(caller.users.totpStatus()).rejects.toThrow();
		await caller.users.updatePassword({
			currentPassword: 'password123',
			newPassword: 'newpassword123',
			confirmNewPassword: 'newpassword123',
		});
		await expect(caller.users.totpStatus()).resolves.toEqual({ enabled: false });
	});

	test('authentication state expires even without a subsequent publication', async () => {
		const { caller } = await initTest(1);
		await caller.users.totpStatus();
		await tdb.update(users).set({ banned: true }).where(eq(users.id, 1));
		// The cached state remains valid only for the documented five-second TTL.
		await expect(caller.users.totpStatus()).resolves.toEqual({ enabled: false });
		await Bun.sleep(5100);
		await expect(caller.users.totpStatus()).rejects.toThrow('User is banned');
	}, 7000);

	test('owner password reset rejects calls on every session of the target', async () => {
		const { caller: ownerCaller } = await initTest(1);
		const { caller: targetCaller } = await initTest(2);
		const targetSocket = createFakeSocket(2, 'desktop');

		trackSockets([targetSocket]);

		await ownerCaller.users.resetPassword({ userId: 2, newPassword: 'ownerreset123' });

		expect(targetSocket.closeCalls.map((call) => call.code)).toEqual([DisconnectCode.KICKED]);
		await expect(targetCaller.users.totpStatus()).rejects.toThrow('Your session is no longer valid');
	});

	test('kick skips an already-closing socket and still closes the open one', async () => {
		const { caller: ownerCaller } = await initTest(1);
		const closingSocket = createFakeSocket(2, 'stale', { readyState: WebSocket.CLOSING });
		const openSocket = createFakeSocket(2, 'live');

		trackSockets([closingSocket, openSocket]);

		await ownerCaller.users.kick({ userId: 2, reason: 'Take a break' });

		expect(closingSocket.closeCalls).toEqual([]);
		expect(openSocket.closeCalls).toEqual([{ code: DisconnectCode.KICKED, reason: 'Take a break' }]);
		expect(isVoiceRestoreBlockedAfterKick(2, { clientInstanceId: 'live' })).toBe(true);
	});

	test('kick reports a user whose only socket is already closing as not connected', async () => {
		const { caller: ownerCaller } = await initTest(1);

		trackSockets([createFakeSocket(2, 'stale', { readyState: WebSocket.CLOSING })]);

		await expect(ownerCaller.users.kick({ userId: 2 })).rejects.toThrow('User is not connected');
	});
});
