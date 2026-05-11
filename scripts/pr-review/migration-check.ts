#!/usr/bin/env bun
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { findRepoRoot, loadReviewConfig } from './common';

type Severity = 'error' | 'warning' | 'info';

interface Finding {
	rule: string;
	severity: Severity;
	line: number;
	snippet: string;
	message: string;
	fix?: string;
}

interface FileReport {
	file: string;
	statementCount: number;
	findings: Finding[];
}

interface Report {
	repoRoot: string;
	generatedAt: string;
	files: FileReport[];
	summary: {
		totalFiles: number;
		totalFindings: number;
		errorCount: number;
		warningCount: number;
	};
}

function parseArgs(argv: string[]): {
	files: string[];
	pr: number | null;
	format: 'json' | 'markdown';
} {
	const files: string[] = [];
	let pr: number | null = null;
	let format: 'json' | 'markdown' = 'json';
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--pr') {
			const next = argv[++i];
			if (!next) throw new Error('--pr requires a value');
			pr = Number.parseInt(next, 10);
			if (Number.isNaN(pr)) throw new Error('--pr must be a number');
		} else if (arg === '--files') {
			const next = argv[++i];
			if (!next) throw new Error('--files requires a value');
			for (const f of next.split(',')) files.push(f.trim());
		} else if (arg === '--format') {
			const next = argv[++i];
			if (next !== 'json' && next !== 'markdown') throw new Error('--format must be json|markdown');
			format = next;
		} else if (arg && !arg.startsWith('--')) {
			files.push(arg);
		}
	}
	return { files, pr, format };
}

function getChangedFilesFromPr(pr: number): string[] {
	const out = execSync(`gh pr diff ${pr} --name-only`, { encoding: 'utf8' });
	return out
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
}

function isMigrationFile(file: string, config: ReturnType<typeof loadReviewConfig>): boolean {
	if (!file.endsWith('.sql')) return false;
	for (const dir of config.migrations.directories) {
		if (file.includes(dir)) return true;
	}
	return new RegExp(config.migrations.fallbackPattern, 'i').test(file);
}

function listExistingMigrations(
	repoRoot: string,
	config: ReturnType<typeof loadReviewConfig>,
): { path: string; content: string }[] {
	const out: { path: string; content: string }[] = [];
	const visit = (dir: string) => {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			const full = resolve(dir, entry);
			const stat = statSync(full);
			if (stat.isDirectory()) {
				visit(full);
				continue;
			}
			if (!stat.isFile() || !entry.endsWith('.sql')) continue;
			out.push({ path: full, content: readFileSync(full, 'utf8') });
		}
	};
	for (const dir of config.migrations.directories) {
		const abs = resolve(repoRoot, dir);
		if (!existsSync(abs)) continue;
		try {
			visit(abs);
		} catch {
			// skip
		}
	}
	return out;
}

function splitStatements(sql: string, config: ReturnType<typeof loadReviewConfig>): { stmt: string; line: number }[] {
	// Some migration frameworks inject statement-break markers. Treat them as
	// separators, but keep line numbers anchored to the source file. This still
	// handles shared-line cases like `DROP TABLE x;--> statement-breakpoint`
	// because we strip the marker before the later `;`-based split.
	let normalized = sql;
	for (const marker of config.migrations.statementBreakMarkers) {
		normalized = normalized.replaceAll(marker, '');
	}
	const lines = normalized.split('\n');
	const out: { stmt: string; line: number }[] = [];
	let buf: string[] = [];
	let startLine = 1;
	const flushBuf = (endLineExclusive: number) => {
		if (buf.length === 0) return;
		const joined = buf.join('\n');
		// Split on ';' to handle multiple statements per buffered chunk.
		let cursor = startLine;
		const parts = joined.split(';');
		for (let p = 0; p < parts.length; p++) {
			const part = parts[p] ?? '';
			const trimmed = part.trim();
			if (trimmed) out.push({ stmt: trimmed, line: cursor });
			// Advance line cursor by the number of newlines in `part` (plus the
			// one consumed by the `;` itself, except for the last fragment).
			const newlines = (part.match(/\n/g) || []).length;
			cursor += newlines;
		}
		buf = [];
		startLine = endLineExclusive;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (buf.length === 0) startLine = i + 1;
		buf.push(line);
	}
	flushBuf(lines.length + 1);
	return out;
}

function snippetFor(stmt: string): string {
	const oneLine = stmt.replace(/\s+/g, ' ').trim();
	return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

function checkStatement(stmt: string, line: number, config: ReturnType<typeof loadReviewConfig>): Finding[] {
	const findings: Finding[] = [];
	const upper = stmt.toUpperCase();
	const snippet = snippetFor(stmt);

	// Rule: ADD COLUMN NOT NULL without DEFAULT.
	const addColumnMatch = upper.match(/ALTER\s+TABLE\s+[^\s]+\s+ADD\s+(COLUMN\s+)?[^\s]+/);
	if (addColumnMatch) {
		const isNotNull = /\bNOT\s+NULL\b/.test(upper);
		const hasDefault = /\bDEFAULT\b/.test(upper);
		if (isNotNull && !hasDefault) {
			findings.push({
				rule: 'ADD_COLUMN_NOT_NULL_WITHOUT_DEFAULT',
				severity: 'error',
				line,
				snippet,
				message: 'ADD COLUMN with NOT NULL but no DEFAULT will fail on tables that already contain rows.',
				fix: 'Add a sensible DEFAULT, or split into: (1) add column nullable, (2) backfill, (3) tighten constraint.',
			});
		}
		// SQLite-specific: cannot add a UNIQUE column via ALTER TABLE.
		if (config.migrations.dialect === 'sqlite' && /\bUNIQUE\b/.test(upper)) {
			findings.push({
				rule: 'ADD_COLUMN_UNIQUE',
				severity: 'error',
				line,
				snippet,
				message: 'SQLite does not allow adding a UNIQUE column via ALTER TABLE. The migration will fail at runtime.',
				fix: 'Add the column without UNIQUE, then create a UNIQUE index in a separate statement.',
			});
		}
	}

	// Rule: DROP TABLE.
	if (/^\s*DROP\s+TABLE\b/i.test(stmt)) {
		const isIfExists = /\bIF\s+EXISTS\b/i.test(stmt);
		findings.push({
			rule: 'DROP_TABLE',
			severity: 'warning',
			line,
			snippet,
			message: isIfExists
				? 'Dropping a table is irreversible. Confirm no live reads/writes target it and that data is preserved if needed.'
				: 'Dropping a table without IF EXISTS will fail on environments where the table was already removed. Confirm no live reads/writes target it.',
			fix: 'If the data is still needed elsewhere, copy it first. Verify with a code search that no producers/consumers remain.',
		});
	}

	// Rule: DROP COLUMN — verify no code references.
	const dropColumn = stmt.match(/ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+DROP\s+(COLUMN\s+)?[`"]?(\w+)[`"]?/i);
	if (dropColumn) {
		findings.push({
			rule: 'DROP_COLUMN',
			severity: 'warning',
			line,
			snippet,
			message: `Dropping column \`${dropColumn[3]}\` from \`${dropColumn[1]}\`. Verify it is no longer referenced in code, schemas, or other migrations.`,
			fix: 'Run a code search for the column name across the repo before merging.',
		});
	}

	// Rule: DELETE without WHERE.
	if (/^\s*DELETE\s+FROM\b/i.test(stmt) && !/\bWHERE\b/i.test(upper)) {
		findings.push({
			rule: 'DELETE_WITHOUT_WHERE',
			severity: 'error',
			line,
			snippet,
			message: 'DELETE without WHERE wipes the entire table.',
			fix: 'Add an explicit WHERE clause, or use DROP TABLE if total removal is intended.',
		});
	}

	// Rule: UPDATE without WHERE.
	if (/^\s*UPDATE\s+/i.test(stmt) && !/\bWHERE\b/i.test(upper)) {
		findings.push({
			rule: 'UPDATE_WITHOUT_WHERE',
			severity: 'warning',
			line,
			snippet,
			message: 'UPDATE without WHERE applies to every row.',
			fix: 'If this is intentional (backfill), confirm in the PR description; otherwise add a WHERE clause.',
		});
	}

	// Rule: TRUNCATE.
	if (/^\s*TRUNCATE\b/i.test(stmt)) {
		findings.push({
			rule: 'TRUNCATE',
			severity: 'error',
			line,
			snippet,
			message: 'TRUNCATE wipes the table.',
			fix: 'Confirm this is intentional and the data is recoverable.',
		});
	}

	return findings;
}

// Extract the primary table name a statement targets, lowercased.
// Returns undefined for statements that don't target a single table.
function tableTargetOf(stmt: string): string | undefined {
	const patterns: RegExp[] = [
		/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?\w+[`"]?\s+ON\s+[`"]?(\w+)[`"]?/i,
		/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i,
		/^\s*ALTER\s+TABLE\s+[`"]?(\w+)[`"]?/i,
		/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i,
		/^\s*DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?[`"]?\w+[`"]?\s+ON\s+[`"]?(\w+)[`"]?/i,
	];
	for (const re of patterns) {
		const m = stmt.match(re);
		if (m?.[1]) return m[1].toLowerCase();
	}
	return undefined;
}

// Detect SQLite "recreate table" idiom that Drizzle emits for column
// constraint changes (nullability, FK ON DELETE, defaults). The DROP TABLE
// that appears mid-sequence is data-preserving, not a real table drop.
//
// Pattern (any 4 consecutive non-PRAGMA statements):
//   1. CREATE TABLE __new_<X> ...
//   2. INSERT INTO __new_<X> ... SELECT ... FROM <X>
//   3. DROP TABLE <X>
//   4. ALTER TABLE __new_<X> RENAME TO <X>
//
// Returns the set of statement line numbers that participate in any matched
// idiom; callers can use this to suppress warnings on those lines.
function detectRecreateIdioms(stmts: { stmt: string; line: number }[]): {
	idiomLines: Set<number>;
	idiomDropLines: Set<number>;
} {
	const idiomLines = new Set<number>();
	const idiomDropLines = new Set<number>();
	const ident = (raw: string | undefined): string | null => (raw ? raw.replace(/[`"]/g, '').toLowerCase() : null);

	for (let i = 0; i + 3 < stmts.length; i++) {
		const a = stmts[i]?.stmt ?? '';
		const b = stmts[i + 1]?.stmt ?? '';
		const c = stmts[i + 2]?.stmt ?? '';
		const d = stmts[i + 3]?.stmt ?? '';

		const create = a.match(/^\s*CREATE\s+TABLE\s+([`"]?)__new_(\w+)\1/i);
		if (!create) continue;
		const table = create[2]?.toLowerCase();
		if (!table) continue;

		const insertTarget = b.match(/INSERT\s+INTO\s+([`"]?)__new_(\w+)\1/i);
		const insertSource = b.match(/FROM\s+([`"]?)(\w+)\1/i);
		if (ident(insertTarget?.[2]) !== table) continue;
		if (ident(insertSource?.[2]) !== table) continue;

		const drop = c.match(/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`"]?)(\w+)\1/i);
		if (ident(drop?.[2]) !== table) continue;

		const rename = d.match(/^\s*ALTER\s+TABLE\s+([`"]?)__new_(\w+)\1\s+RENAME\s+TO\s+([`"]?)(\w+)\3/i);
		if (ident(rename?.[2]) !== table || ident(rename?.[4]) !== table) continue;

		const aLine = stmts[i]?.line;
		const bLine = stmts[i + 1]?.line;
		const cLine = stmts[i + 2]?.line;
		const dLine = stmts[i + 3]?.line;
		if (aLine !== undefined) idiomLines.add(aLine);
		if (bLine !== undefined) idiomLines.add(bLine);
		if (cLine !== undefined) {
			idiomLines.add(cLine);
			idiomDropLines.add(cLine);
		}
		if (dLine !== undefined) idiomLines.add(dLine);
	}

	return { idiomLines, idiomDropLines };
}

function tablesDroppedInFile(sql: string, config: ReturnType<typeof loadReviewConfig>): Set<string> {
	const dropped = new Set<string>();
	for (const { stmt } of splitStatements(sql, config)) {
		const m = stmt.match(/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i);
		if (m?.[1]) dropped.add(m[1].toLowerCase());
	}
	return dropped;
}

function detectDuplicateOfOlder(
	currentFile: string,
	currentSql: string,
	existing: { path: string; content: string }[],
	config: ReturnType<typeof loadReviewConfig>,
): Finding[] {
	// Heuristic from AGENTS.md: drizzle's db:gen can re-include older statements.
	// Flag any non-trivial statement in the new migration that appears verbatim
	// (or near-verbatim) in an *older* migration (strictly lower basename).
	// Skip files with the same basename as the current one — those are the same
	// migration emitted to a parallel output directory, not a duplicate.
	// Skip statements that target a table the current migration drops earlier
	// in the file — that is a legitimate rebuild pattern (DROP table → CREATE
	// new table → recreate indexes), not an accidental re-emission.
	const findings: Finding[] = [];
	const currentBase = currentFile.split('/').pop() ?? '';
	const droppedHere = tablesDroppedInFile(currentSql, config);
	const stmts = splitStatements(currentSql, config);
	for (const { stmt, line } of stmts) {
		if (stmt.length < 40) continue;
		const target = tableTargetOf(stmt);
		if (target && droppedHere.has(target)) continue;
		const norm = stmt.replace(/\s+/g, ' ').trim().toLowerCase();
		for (const other of existing) {
			if (other.path === currentFile) continue;
			const otherBase = other.path.split('/').pop() ?? '';
			if (otherBase === currentBase) continue;
			if (otherBase >= currentBase) continue;
			const otherNorm = other.content.replace(/\s+/g, ' ').toLowerCase();
			if (otherNorm.includes(norm)) {
				findings.push({
					rule: 'DUPLICATE_OF_OLDER_MIGRATION',
					severity: 'error',
					line,
					snippet: snippetFor(stmt),
					message: `Statement appears verbatim in an earlier migration (${relative(dirname(currentFile), other.path)}). Drizzle's db:gen can re-emit older statements; this will likely fail to apply.`,
					fix: 'Open the generated SQL and remove statements that already exist in earlier migrations. Keep only the intended new delta.',
				});
				break;
			}
		}
	}
	return findings;
}

function analyzeFile(
	absPath: string,
	repoRoot: string,
	existing: { path: string; content: string }[],
	config: ReturnType<typeof loadReviewConfig>,
): FileReport {
	const content = readFileSync(absPath, 'utf8');
	const stmts = splitStatements(content, config);
	const findings: Finding[] = [];
	for (const { stmt, line } of stmts) {
		findings.push(...checkStatement(stmt, line, config));
	}
	findings.push(...detectDuplicateOfOlder(absPath, content, existing, config));

	// Suppress DROP_TABLE warnings inside the SQLite recreate-table idiom —
	// they are data-preserving by construction (the prior INSERT…SELECT moves
	// every row into the replacement table).
	const { idiomDropLines } =
		config.migrations.dialect === 'sqlite' ? detectRecreateIdioms(stmts) : { idiomDropLines: new Set<number>() };
	for (const f of findings) {
		if (f.rule === 'DROP_TABLE' && idiomDropLines.has(f.line)) {
			f.severity = 'info';
			f.rule = 'DROP_TABLE_IN_RECREATE_IDIOM';
			f.message =
				'DROP TABLE is part of the SQLite recreate-table idiom (CREATE __new_X → INSERT…SELECT → DROP X → RENAME __new_X). Data is preserved by the preceding INSERT.';
			f.fix = undefined;
		}
	}

	findings.sort((a, b) => a.line - b.line);
	return {
		file: relative(repoRoot, absPath),
		statementCount: stmts.length,
		findings,
	};
}

function renderMarkdown(report: Report): string {
	const lines: string[] = [];
	lines.push(`# Migration safety report`);
	lines.push('');
	lines.push(
		`Analyzed **${report.summary.totalFiles}** migration file(s). Found **${report.summary.errorCount}** error(s) and **${report.summary.warningCount}** warning(s).`,
	);
	lines.push('');
	if (report.summary.totalFindings === 0) {
		lines.push('_No issues detected._');
		return lines.join('\n');
	}
	for (const f of report.files) {
		if (f.findings.length === 0) continue;
		lines.push(`## ${f.file}`);
		for (const finding of f.findings) {
			lines.push(
				`- **${finding.severity.toUpperCase()}** \`${finding.rule}\` (line ${finding.line}): ${finding.message}`,
			);
			lines.push(`  - statement: \`${finding.snippet}\``);
			if (finding.fix) lines.push(`  - fix: ${finding.fix}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

async function main() {
	const { files: rawFiles, pr, format } = parseArgs(process.argv.slice(2));
	const repoRoot = findRepoRoot(process.cwd());
	const config = loadReviewConfig(repoRoot);

	let files: string[] = rawFiles;
	if (pr !== null) {
		try {
			files = files.concat(getChangedFilesFromPr(pr));
		} catch (err) {
			console.error(`Failed to read PR ${pr}: ${(err as Error).message}`);
			process.exit(1);
		}
	}

	files = files
		.map((f) => (isAbsolute(f) ? f : resolve(repoRoot, f)))
		.filter((f) => existsSync(f))
		.filter((f) => isMigrationFile(f, config));

	const existing = listExistingMigrations(repoRoot, config);

	const fileReports: FileReport[] = [];
	for (const file of files) {
		fileReports.push(analyzeFile(file, repoRoot, existing, config));
	}

	const totalFindings = fileReports.reduce((acc, f) => acc + f.findings.length, 0);
	const errorCount = fileReports.reduce((acc, f) => acc + f.findings.filter((x) => x.severity === 'error').length, 0);
	const warningCount = fileReports.reduce(
		(acc, f) => acc + f.findings.filter((x) => x.severity === 'warning').length,
		0,
	);

	const report: Report = {
		repoRoot,
		generatedAt: new Date().toISOString(),
		files: fileReports,
		summary: {
			totalFiles: fileReports.length,
			totalFindings,
			errorCount,
			warningCount,
		},
	};

	console.log(format === 'markdown' ? renderMarkdown(report) : JSON.stringify(report, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
