import { expect, test } from 'bun:test';

for (const mode of [
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
