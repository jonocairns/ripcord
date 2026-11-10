import { expect, test } from 'bun:test';

for (const mode of ['success', 'failure', 'connect-failure', 'connect-refresh', 'handshake-success']) {
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
