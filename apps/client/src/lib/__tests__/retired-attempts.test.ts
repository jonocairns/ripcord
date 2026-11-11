import { expect, test } from 'bun:test';

for (const mode of [
	'read-connection-state',
	'trace-connect',
	'trace-drop-resume',
	'trace-drop-resume-voice',
	'trace-terminal-kicked',
	'trace-terminal-banned',
	'trace-terminal-after-drop',
	'trace-cleanup',
	'trace-cleanup-pending',
	'trace-replace',
	'trace-replace-pending',
	'trace-grace-expiry',
	'grace-rearm',
	'grace-offline',
	'open-offline-defer',
	'open-offline-socket-closed',
	'open-online-socket-closed',
	'open-without-drop',
	'first-connect-drop',
	'must-change-password',
	'edge-b-replacement-drop',
	'edge-c-online',
	'edge-c-expiry',
	'gate',
	'gate-readystate',

	'rejoin-failure',
	'rejoin-client-error',
	'rejoin-retry-failure',
	'rejoin-untyped-transport',
	'rejoin-auth-failure',
	'rejoin-forbidden',
	'rejoin-refresh-rejected',
	'rejoin-refresh-offline',
	'rejoin-password',
	'kicked',
	'banned',
	'logout',
	'success',
	'failure',
	'connect-failure',
	'connect-refresh',
	'handshake-success',
	'initial-reopen',
	'close-refresh',
	'refresh-replacement-drop',
]) {
	test(`retired connection lifecycle: ${mode}`, async () => {
		const child = Bun.spawn(
			[process.execPath, new URL('./fixtures/retired-attempts.ts', import.meta.url).pathname, mode],
			{
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(stderr).toBe('');
		expect(code).toBe(0);
	});
}
