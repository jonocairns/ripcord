#!/usr/bin/env bun
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { findRepoRoot, loadReviewConfig, renderTemplate, validateTypecheckErrorPatterns } from './common';

interface TscError {
	file: string;
	line: number;
	col: number;
	code: string;
	message: string;
}

interface Report {
	repoRoot: string;
	generatedAt: string;
	cmd: string;
	exitCode: number;
	passed: boolean;
	totalErrors: number;
	inScopeErrors: number;
	pr: number | null;
	changedFiles: string[];
	errors: TscError[];
	truncated: boolean;
}

const MAX_ERRORS_RENDERED = 50;

function parseArgs(argv: string[]): {
	pr: number | null;
	format: 'json' | 'markdown';
	scope: string | null;
} {
	let pr: number | null = null;
	let format: 'json' | 'markdown' = 'markdown';
	let scope: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--pr') {
			const next = argv[++i];
			if (!next) throw new Error('--pr requires a value');
			pr = Number.parseInt(next, 10);
			if (Number.isNaN(pr)) throw new Error('--pr must be a number');
		} else if (a === '--format') {
			const next = argv[++i];
			if (next !== 'json' && next !== 'markdown') throw new Error('--format must be json|markdown');
			format = next;
		} else if (a === '--scope') {
			scope = argv[++i] ?? null;
		}
	}
	return { pr, format, scope };
}

function getChangedFiles(pr: number): string[] {
	return execSync(`gh pr diff ${pr} --name-only`, { encoding: 'utf8' })
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean)
		.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
}

function parseTypecheckOutput(
	output: string,
	repoRoot: string,
	config: ReturnType<typeof loadReviewConfig>,
): TscError[] {
	const errors: TscError[] = [];
	const seen = new Set<string>();

	for (const parser of config.typecheck.errorPatterns) {
		// Capture groups must be: file, line, column, TS code, message.
		const flags = parser.flags.includes('g') ? parser.flags : `${parser.flags}g`;
		const re = new RegExp(parser.pattern, flags);
		let m: RegExpExecArray | null;
		while ((m = re.exec(output)) !== null) {
			const [, file, line, col, code, message] = m;
			if (!file) continue;
			const candidates = [resolve(repoRoot, file), resolve(process.cwd(), file)];
			const abs = candidates.find((c) => existsSync(c)) ?? candidates[0];
			if (!abs) continue;
			const rel = relative(repoRoot, abs);
			const key = `${rel}:${line}:${col}:${code}`;
			if (seen.has(key)) continue;
			seen.add(key);
			errors.push({
				file: rel,
				line: Number.parseInt(line ?? '0', 10),
				col: Number.parseInt(col ?? '0', 10),
				code: code ?? '',
				message: (message ?? '').trim(),
			});
		}
	}

	return errors;
}

function runTypecheck(
	repoRoot: string,
	scope: string | null,
	config: ReturnType<typeof loadReviewConfig>,
): { output: string; exitCode: number; cmd: string } {
	const cmd = scope
		? renderTemplate(config.typecheck.scopedCommandTemplate, { SCOPE: scope })
		: config.typecheck.defaultCommand;
	const result = spawnSync('bash', ['-lc', cmd], {
		cwd: repoRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: config.typecheck.timeoutMs,
	});
	const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
	return { output, exitCode: result.status ?? 1, cmd };
}

function renderMarkdown(report: Report): string {
	const lines: string[] = [];
	lines.push('# Typecheck report');
	lines.push('');
	lines.push(`Command: \`${report.cmd}\``);
	lines.push(`Result: **${report.passed ? 'PASS' : 'FAIL'}**`);
	if (report.pr !== null) {
		lines.push(`Total errors: ${report.totalErrors}`);
		lines.push(`Errors in PR-changed files (#${report.pr}): ${report.inScopeErrors}`);
	} else {
		lines.push(`Errors: ${report.totalErrors}`);
	}
	lines.push('');
	if (report.errors.length === 0) {
		if (report.passed) {
			lines.push('_Typecheck passes._');
		} else {
			lines.push(
				'_Typecheck failed but no `error TSxxxx:` lines were parsed — re-run manually to see the raw output._',
			);
		}
		return lines.join('\n');
	}
	lines.push('## Errors');
	for (const e of report.errors) {
		lines.push(`- ${e.file}:${e.line}:${e.col} \`${e.code}\` ${e.message}`);
	}
	if (report.truncated) {
		lines.push(`- ...and ${report.inScopeErrors - report.errors.length} more (truncated)`);
	}
	return lines.join('\n');
}

async function main() {
	const { pr, format, scope } = parseArgs(process.argv.slice(2));
	const repoRoot = findRepoRoot(process.cwd());
	const config = loadReviewConfig(repoRoot);
	validateTypecheckErrorPatterns(config);

	let changed: string[] = [];
	if (pr !== null) {
		try {
			changed = getChangedFiles(pr);
		} catch (err) {
			console.error(`Failed to read PR ${pr}: ${(err as Error).message}`);
			process.exit(1);
		}
	}

	const { output, exitCode, cmd } = runTypecheck(repoRoot, scope, config);
	const allErrors = parseTypecheckOutput(output, repoRoot, config);

	const inScope =
		changed.length > 0 ? allErrors.filter((e) => changed.some((c) => c === e.file || e.file.endsWith(c))) : allErrors;

	const report: Report = {
		repoRoot,
		generatedAt: new Date().toISOString(),
		cmd,
		exitCode,
		passed: exitCode === 0,
		totalErrors: allErrors.length,
		inScopeErrors: inScope.length,
		pr,
		changedFiles: changed,
		errors: inScope.slice(0, MAX_ERRORS_RENDERED),
		truncated: inScope.length > MAX_ERRORS_RENDERED,
	};

	console.log(format === 'markdown' ? renderMarkdown(report) : JSON.stringify(report, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
