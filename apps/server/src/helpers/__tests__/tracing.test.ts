import { expect, test } from 'bun:test';

// Isolate SDK/global OTel initialization from the shared server test process.
test('standard OTLP export preserves remote parent sampling, server identity and isolated async context', async () => {
	const smokePath = new URL('./fixtures/tracing-smoke.ts', import.meta.url).pathname;
	const process = Bun.spawn([Bun.which('bun') ?? 'bun', smokePath], { stdout: 'pipe', stderr: 'pipe' });
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	expect(stderr).toBe('');
	expect(exitCode).toBe(0);
	expect(stdout).toContain('OTel bridge, parent context, concurrent async isolation, disabled tracing: passed');
});
