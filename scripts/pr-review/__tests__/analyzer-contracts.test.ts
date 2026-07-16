import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../..');

async function runAnalyzer(script: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	const process = Bun.spawn(['bun', 'run', script, ...args], {
		cwd: repoRoot,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`${script} failed (${exitCode}): ${stderr}`);
	}
	return { stdout, stderr };
}

describe('PR review analyzer contracts', () => {
	test('migration analyzer reports its bounded static rules', async () => {
		const fixture = 'scripts/pr-review/__tests__/fixtures/migrations/unsafe.sql';
		const { stdout } = await runAnalyzer('scripts/pr-review/migration-check.ts', [fixture, '--format', 'json']);
		const report = JSON.parse(stdout) as {
			files: { findings: { rule: string }[] }[];
		};
		const rules = report.files.flatMap((file) => file.findings.map((finding) => finding.rule));

		expect(rules).toContain('ADD_COLUMN_NOT_NULL_WITHOUT_DEFAULT');
		expect(rules).toContain('DELETE_WITHOUT_WHERE');
	});

	test('symbol diff reports an added exported symbol fixture', async () => {
		const fixture = 'scripts/pr-review/__tests__/fixtures/symbol-added.ts';
		const { stdout } = await runAnalyzer('scripts/pr-review/symbol-diff.ts', [
			fixture,
			'--base',
			'refs/heads/pr-review-fixture-without-symbol',
			'--format',
			'json',
		]);
		const report = JSON.parse(stdout) as { summary: { addedSymbols: number } };

		expect(report.summary.addedSymbols).toBeGreaterThanOrEqual(1);
	});

	test('tRPC analyzer maps the configured router tree', async () => {
		const { stdout } = await runAnalyzer('scripts/pr-review/trpc-edges.ts', ['--all', '--format', 'json']);
		const report = JSON.parse(stdout) as { totalRoutes: number; coverage: { status: string } };

		expect(report.totalRoutes).toBeGreaterThan(0);
		expect(report.coverage.status).not.toBe('unsupported');
	}, 30_000);

	test('import graph analyzer writes a readable graph', async () => {
		await runAnalyzer('scripts/pr-review/build-import-graph.ts', []);
		const graphPath = resolve(repoRoot, '.pr-review-cache/import-graph.json');

		expect(existsSync(graphPath)).toBeTrue();
		const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as { edges: Record<string, string[]> };
		expect(Object.keys(graph.edges).length).toBeGreaterThan(0);
	}, 30_000);
});
