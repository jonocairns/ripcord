import { expect, test } from 'bun:test';

test('real browser OTel backend preserves context, sampling and cancels stale identity delivery', async () => {
	const fixture = new URL('./fixtures/tracing-backend.ts', import.meta.url).pathname;
	const child = Bun.spawn([Bun.which('bun') ?? 'bun', fixture], { stdout: 'pipe', stderr: 'pipe' });
	const [code, out, err] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(err).toBe('');
	expect(code).toBe(0);
	expect(out).toContain('client span graph, identity switch, sampling, bounded outage: passed');
}, 10000);
