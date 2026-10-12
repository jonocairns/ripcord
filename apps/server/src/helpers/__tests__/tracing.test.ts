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

test('WSS error reporting retains the original exported RPC span after async context exits', async () => {
	const smokePath = new URL('./fixtures/rpc-error-trace.ts', import.meta.url).pathname;
	const child = Bun.spawn([Bun.which('bun') ?? 'bun', smokePath], { stdout: 'pipe', stderr: 'pipe' });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(stderr).toBe('');
	expect(exitCode).toBe(0);
	expect(stdout).toContain('RPC error callback retains original exported span context exactly once: passed');
});
