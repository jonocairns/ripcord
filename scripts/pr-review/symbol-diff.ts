#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Node, Project, type SourceFile, ts, type VariableDeclaration } from 'ts-morph';
import { findRepoRoot } from './common';

type SymbolStatus = 'added' | 'removed' | 'modified';

interface SymbolSnapshot {
	name: string;
	kind: string;
	signature: string;
	line: number;
	text: string;
	members: string[];
	callees: string[];
	riskTags: string[];
}

interface SymbolChange {
	name: string;
	kind: string;
	status: SymbolStatus;
	line: number | null;
	oldSignature?: string;
	newSignature?: string;
	signatureChanged: boolean;
	addedMembers: string[];
	removedMembers: string[];
	addedCallees: string[];
	removedCallees: string[];
	addedRiskTags: string[];
	removedRiskTags: string[];
	bodyChanged: boolean;
}

interface FileReport {
	file: string;
	status: 'added' | 'removed' | 'modified' | 'unchanged';
	changes: SymbolChange[];
	error?: string;
}

interface Report {
	repoRoot: string;
	generatedAt: string;
	pr: number | null;
	baseRef: string;
	files: FileReport[];
	summary: {
		totalFiles: number;
		totalChangedSymbols: number;
		addedSymbols: number;
		removedSymbols: number;
		modifiedSymbols: number;
		symbolsWithSignatureChanges: number;
		symbolsWithCalleeChanges: number;
		riskTags: string[];
	};
}

function parseArgs(argv: string[]): {
	files: string[];
	pr: number | null;
	baseRef: string | null;
	format: 'json' | 'markdown';
} {
	const files: string[] = [];
	let pr: number | null = null;
	let baseRef: string | null = null;
	let format: 'json' | 'markdown' = 'json';

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--pr') {
			const next = argv[++i];
			if (!next) throw new Error('--pr requires a value');
			pr = Number.parseInt(next, 10);
			if (Number.isNaN(pr)) throw new Error('--pr must be a number');
		} else if (arg === '--base') {
			const next = argv[++i];
			if (!next) throw new Error('--base requires a value');
			baseRef = next;
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

	return { files, pr, baseRef, format };
}

function run(command: string, args: string[], cwd: string): string {
	return execFileSync(command, args, { cwd, encoding: 'utf8' });
}

function getChangedFilesFromPr(pr: number, repoRoot: string): string[] {
	const out = run('gh', ['pr', 'diff', String(pr), '--name-only'], repoRoot);
	return out
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
}

function getBaseRefFromPr(pr: number, repoRoot: string): string {
	const base = run('gh', ['pr', 'view', String(pr), '--json', 'baseRefName', '--jq', '.baseRefName'], repoRoot).trim();
	return base ? `refs/remotes/origin/${base}` : 'HEAD';
}

function readGitFile(repoRoot: string, baseRef: string, file: string): string | null {
	const candidates = [
		baseRef,
		baseRef.startsWith('refs/') ? baseRef.replace('refs/remotes/origin/', 'origin/') : baseRef,
	];
	for (const candidate of candidates) {
		try {
			return run('git', ['show', `${candidate}:${file}`], repoRoot);
		} catch {
			// Try the next spelling. A missing file at base is normal for added files.
		}
	}
	return null;
}

function isAnalyzable(file: string): boolean {
	if (!/\.(ts|tsx|mts|cts)$/.test(file)) return false;
	if (/\.d\.ts$/.test(file)) return false;
	if (/\bnode_modules\b/.test(file)) return false;
	if (/(^|\/)(dist|build)(\/|$)/.test(file)) return false;
	if (/\.(test|spec)\.tsx?$/.test(file)) return false;
	return true;
}

function normalizeText(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function declarationKind(decl: Node): string {
	if (Node.isFunctionDeclaration(decl)) return 'function';
	if (Node.isClassDeclaration(decl)) return 'class';
	if (Node.isInterfaceDeclaration(decl)) return 'interface';
	if (Node.isTypeAliasDeclaration(decl)) return 'type';
	if (Node.isEnumDeclaration(decl)) return 'enum';
	if (Node.isVariableDeclaration(decl)) return 'variable';
	return decl.getKindName();
}

function parametersText(node: { getParameters: () => { getText: () => string }[] }): string {
	return node
		.getParameters()
		.map((p) => normalizeText(p.getText()))
		.join(', ');
}

function returnTypeText(node: { getReturnTypeNode: () => Node | undefined }): string {
	const returnType = node.getReturnTypeNode();
	return returnType ? `: ${normalizeText(returnType.getText())}` : '';
}

function variableSignature(decl: VariableDeclaration, name: string): string {
	const initializer = decl.getInitializer();
	if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
		return `const ${name} = (${parametersText(initializer)})${returnTypeText(initializer)}`;
	}
	const typeNode = decl.getTypeNode();
	return `const ${name}${typeNode ? `: ${normalizeText(typeNode.getText())}` : ''}`;
}

function signatureFor(name: string, decl: Node): string {
	if (Node.isFunctionDeclaration(decl)) {
		return `function ${name}(${parametersText(decl)})${returnTypeText(decl)}`;
	}
	if (Node.isClassDeclaration(decl)) return `class ${name}`;
	if (Node.isInterfaceDeclaration(decl)) return `interface ${name}`;
	if (Node.isTypeAliasDeclaration(decl)) {
		const typeNode = decl.getTypeNode();
		return `type ${name}${typeNode ? ` = ${normalizeText(typeNode.getText())}` : ''}`;
	}
	if (Node.isEnumDeclaration(decl)) return `enum ${name}`;
	if (Node.isVariableDeclaration(decl)) return variableSignature(decl, name);
	return normalizeText(decl.getText()).slice(0, 200);
}

function isPrivateMemberText(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith('private ') || trimmed.startsWith('protected ') || trimmed.startsWith('#');
}

function membersFor(decl: Node): string[] {
	const members: string[] = [];
	if (Node.isClassDeclaration(decl)) {
		for (const member of decl.getMembers()) {
			const text = member.getText();
			if (isPrivateMemberText(text)) continue;
			if (Node.isMethodDeclaration(member)) {
				members.push(`method ${member.getName()}(${parametersText(member)})${returnTypeText(member)}`);
			} else if (Node.isPropertyDeclaration(member)) {
				const typeNode = member.getTypeNode();
				members.push(`property ${member.getName()}${typeNode ? `: ${normalizeText(typeNode.getText())}` : ''}`);
			}
		}
	}
	if (Node.isInterfaceDeclaration(decl)) {
		for (const member of decl.getMembers()) {
			if (Node.isMethodSignature(member)) {
				members.push(`method ${member.getName()}(${parametersText(member)})${returnTypeText(member)}`);
			} else if (Node.isPropertySignature(member)) {
				const typeNode = member.getTypeNode();
				members.push(
					`property ${member.getName()}${member.hasQuestionToken() ? '?' : ''}${typeNode ? `: ${normalizeText(typeNode.getText())}` : ''}`,
				);
			}
		}
	}
	if (Node.isEnumDeclaration(decl)) {
		for (const member of decl.getMembers()) {
			const initializer = member.getInitializer();
			members.push(`member ${member.getName()}${initializer ? ` = ${normalizeText(initializer.getText())}` : ''}`);
		}
	}
	return [...new Set(members)].sort();
}

function getCallableBodyRoot(decl: Node): Node {
	if (Node.isVariableDeclaration(decl)) {
		const initializer = decl.getInitializer();
		return initializer ?? decl;
	}
	return decl;
}

function calleeText(call: Node): string | null {
	if (Node.isCallExpression(call)) {
		return normalizeText(call.getExpression().getText()).slice(0, 180);
	}
	if (Node.isNewExpression(call)) {
		const expr = call.getExpression();
		return expr ? `new ${normalizeText(expr.getText()).slice(0, 176)}` : 'new <unknown>';
	}
	return null;
}

function calleesFor(decl: Node): string[] {
	if (Node.isInterfaceDeclaration(decl) || Node.isTypeAliasDeclaration(decl) || Node.isEnumDeclaration(decl)) return [];
	const root = getCallableBodyRoot(decl);
	const callees: string[] = [];
	for (const call of root.getDescendants()) {
		if (!Node.isCallExpression(call) && !Node.isNewExpression(call)) continue;
		const text = calleeText(call);
		if (text) callees.push(text);
	}
	return [...new Set(callees)].sort();
}

function riskTagsFor(callees: string[]): string[] {
	const tags = new Set<string>();
	for (const callee of callees) {
		if (/\b(fetch|axios|ky|request)\b|\.fetch\b/i.test(callee)) tags.add('network');
		if (/\b(db|tx|database)\.(insert|update|delete)|\.(insert|update|delete)\b/i.test(callee)) tags.add('db-write');
		if (/\b(db|tx|database)\.(select|query)|\b(findFirst|findMany|findUnique)\b|\.(select|query)\b/i.test(callee))
			tags.add('db-read');
		if (/\b(hasPermission|protectedProcedure|publicProcedure|authenticated|auth|authorize|permission)\b/i.test(callee))
			tags.add('auth');
		if (/\b(readFile|writeFile|appendFile|mkdir|rm|unlink|rename)\b|\bfs\./i.test(callee)) tags.add('filesystem');
		if (/\b(exec|execSync|execFile|execFileSync|spawn|spawnSync|shell)\b/i.test(callee)) tags.add('shell');
		if (/\b(logger|console)\.(debug|info|warn|error|log)\b/i.test(callee)) tags.add('logging');
		if (/\b(crypto|bcrypt|hash|sign|verify|encrypt|decrypt)\b/i.test(callee)) tags.add('crypto');
		if (/\b(setTimeout|setInterval|queueMicrotask|requestAnimationFrame)\b/i.test(callee)) tags.add('async-timing');
	}
	return [...tags].sort();
}

function parseSource(file: string, text: string, label: string): SourceFile {
	const project = new Project({
		compilerOptions: {
			jsx: ts.JsxEmit.ReactJSX,
			target: ts.ScriptTarget.Latest,
			module: ts.ModuleKind.NodeNext,
		},
	});
	return project.createSourceFile(`/__pr_review__/${label}/${file}`, text, { overwrite: true });
}

function snapshotExports(file: string, text: string, label: string): Map<string, SymbolSnapshot> {
	const sourceFile = parseSource(file, text, label);
	const snapshots = new Map<string, SymbolSnapshot>();
	for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
		const decl = declarations[0];
		if (!decl) continue;
		const kind = declarationKind(decl);
		const callees = calleesFor(decl);
		snapshots.set(name, {
			name,
			kind,
			signature: signatureFor(name, decl),
			line: decl.getStartLineNumber(),
			text: normalizeText(decl.getText()),
			members: membersFor(decl),
			callees,
			riskTags: riskTagsFor(callees),
		});
	}
	return snapshots;
}

function diffList(oldValues: string[], newValues: string[]): { added: string[]; removed: string[] } {
	const oldSet = new Set(oldValues);
	const newSet = new Set(newValues);
	return {
		added: newValues.filter((value) => !oldSet.has(value)),
		removed: oldValues.filter((value) => !newSet.has(value)),
	};
}

function compareSymbols(
	oldSymbols: Map<string, SymbolSnapshot>,
	newSymbols: Map<string, SymbolSnapshot>,
): SymbolChange[] {
	const names = [...new Set([...oldSymbols.keys(), ...newSymbols.keys()])].sort();
	const changes: SymbolChange[] = [];

	for (const name of names) {
		const oldSymbol = oldSymbols.get(name);
		const newSymbol = newSymbols.get(name);
		if (!oldSymbol && newSymbol) {
			changes.push({
				name,
				kind: newSymbol.kind,
				status: 'added',
				line: newSymbol.line,
				newSignature: newSymbol.signature,
				signatureChanged: true,
				addedMembers: newSymbol.members,
				removedMembers: [],
				addedCallees: newSymbol.callees,
				removedCallees: [],
				addedRiskTags: newSymbol.riskTags,
				removedRiskTags: [],
				bodyChanged: true,
			});
			continue;
		}
		if (oldSymbol && !newSymbol) {
			changes.push({
				name,
				kind: oldSymbol.kind,
				status: 'removed',
				line: oldSymbol.line,
				oldSignature: oldSymbol.signature,
				signatureChanged: true,
				addedMembers: [],
				removedMembers: oldSymbol.members,
				addedCallees: [],
				removedCallees: oldSymbol.callees,
				addedRiskTags: [],
				removedRiskTags: oldSymbol.riskTags,
				bodyChanged: true,
			});
			continue;
		}
		if (!oldSymbol || !newSymbol) continue;

		const memberDiff = diffList(oldSymbol.members, newSymbol.members);
		const calleeDiff = diffList(oldSymbol.callees, newSymbol.callees);
		const riskDiff = diffList(oldSymbol.riskTags, newSymbol.riskTags);
		const signatureChanged = oldSymbol.signature !== newSymbol.signature || oldSymbol.kind !== newSymbol.kind;
		const bodyChanged = oldSymbol.text !== newSymbol.text;
		const changed =
			signatureChanged ||
			bodyChanged ||
			memberDiff.added.length > 0 ||
			memberDiff.removed.length > 0 ||
			calleeDiff.added.length > 0 ||
			calleeDiff.removed.length > 0 ||
			riskDiff.added.length > 0 ||
			riskDiff.removed.length > 0;

		if (!changed) continue;
		changes.push({
			name,
			kind: newSymbol.kind,
			status: 'modified',
			line: newSymbol.line,
			oldSignature: oldSymbol.signature,
			newSignature: newSymbol.signature,
			signatureChanged,
			addedMembers: memberDiff.added,
			removedMembers: memberDiff.removed,
			addedCallees: calleeDiff.added,
			removedCallees: calleeDiff.removed,
			addedRiskTags: riskDiff.added,
			removedRiskTags: riskDiff.removed,
			bodyChanged,
		});
	}

	return changes;
}

function analyzeFile(repoRoot: string, file: string, baseRef: string): FileReport {
	const abs = isAbsolute(file) ? file : resolve(repoRoot, file);
	const rel = isAbsolute(file) ? relative(repoRoot, file) : file;
	const oldText = readGitFile(repoRoot, baseRef, rel);
	const newText = existsSync(abs) ? readFileSync(abs, 'utf8') : null;

	if (oldText === null && newText === null) {
		return { file: rel, status: 'unchanged', changes: [], error: 'file not found in base or working tree' };
	}

	try {
		const oldSymbols = oldText === null ? new Map<string, SymbolSnapshot>() : snapshotExports(rel, oldText, 'base');
		const newSymbols = newText === null ? new Map<string, SymbolSnapshot>() : snapshotExports(rel, newText, 'head');
		const changes = compareSymbols(oldSymbols, newSymbols);
		const status =
			oldText === null ? 'added' : newText === null ? 'removed' : changes.length > 0 ? 'modified' : 'unchanged';
		return { file: rel, status, changes };
	} catch (error) {
		return { file: rel, status: 'modified', changes: [], error: (error as Error).message };
	}
}

function renderMarkdown(report: Report): string {
	const lines: string[] = [];
	lines.push('# Symbol diff report');
	lines.push('');
	lines.push(
		`Analyzed **${report.summary.totalFiles}** file(s), found **${report.summary.totalChangedSymbols}** changed exported symbol(s).`,
	);
	lines.push(
		`Added: ${report.summary.addedSymbols}, removed: ${report.summary.removedSymbols}, modified: ${report.summary.modifiedSymbols}.`,
	);
	if (report.summary.riskTags.length > 0) {
		lines.push(`Risk tags: ${report.summary.riskTags.map((tag) => `\`${tag}\``).join(', ')}`);
	}
	lines.push('');

	if (report.summary.totalChangedSymbols === 0) {
		lines.push('_No exported symbol changes detected._');
		return lines.join('\n');
	}

	for (const file of report.files) {
		if (file.error) {
			lines.push(`## ${file.file}`);
			lines.push(`> error: ${file.error}`);
			lines.push('');
			continue;
		}
		if (file.changes.length === 0) continue;
		lines.push(`## ${file.file}`);
		for (const change of file.changes) {
			lines.push(
				`- **${change.status.toUpperCase()}** \`${change.name}\` (${change.kind})${change.line ? ` at line ${change.line}` : ''}`,
			);
			if (change.signatureChanged) {
				if (change.oldSignature) lines.push(`  - old: \`${change.oldSignature}\``);
				if (change.newSignature) lines.push(`  - new: \`${change.newSignature}\``);
			}
			if (change.addedMembers.length > 0)
				lines.push(`  - added members: ${change.addedMembers.map((m) => `\`${m}\``).join(', ')}`);
			if (change.removedMembers.length > 0)
				lines.push(`  - removed members: ${change.removedMembers.map((m) => `\`${m}\``).join(', ')}`);
			if (change.addedCallees.length > 0)
				lines.push(`  - added callees: ${change.addedCallees.map((c) => `\`${c}\``).join(', ')}`);
			if (change.removedCallees.length > 0)
				lines.push(`  - removed callees: ${change.removedCallees.map((c) => `\`${c}\``).join(', ')}`);
			if (change.addedRiskTags.length > 0)
				lines.push(`  - added risk tags: ${change.addedRiskTags.map((tag) => `\`${tag}\``).join(', ')}`);
			if (change.removedRiskTags.length > 0)
				lines.push(`  - removed risk tags: ${change.removedRiskTags.map((tag) => `\`${tag}\``).join(', ')}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

async function main() {
	const { files: rawFiles, pr, baseRef: argBaseRef, format } = parseArgs(process.argv.slice(2));
	const repoRoot = findRepoRoot(process.cwd());
	let files = rawFiles;
	if (pr !== null) files = files.concat(getChangedFilesFromPr(pr, repoRoot));

	const baseRef = argBaseRef ?? (pr !== null ? getBaseRefFromPr(pr, repoRoot) : 'HEAD');
	files = [
		...new Set(
			files
				.map((f) => f.trim())
				.filter(Boolean)
				.filter(isAnalyzable),
		),
	];

	const reports = files.map((file) => analyzeFile(repoRoot, file, baseRef));
	const changes = reports.flatMap((file) => file.changes);
	const riskTags = [
		...new Set(changes.flatMap((change) => [...change.addedRiskTags, ...change.removedRiskTags])),
	].sort();
	const report: Report = {
		repoRoot,
		generatedAt: new Date().toISOString(),
		pr,
		baseRef,
		files: reports,
		summary: {
			totalFiles: reports.length,
			totalChangedSymbols: changes.length,
			addedSymbols: changes.filter((change) => change.status === 'added').length,
			removedSymbols: changes.filter((change) => change.status === 'removed').length,
			modifiedSymbols: changes.filter((change) => change.status === 'modified').length,
			symbolsWithSignatureChanges: changes.filter((change) => change.signatureChanged).length,
			symbolsWithCalleeChanges: changes.filter(
				(change) => change.addedCallees.length > 0 || change.removedCallees.length > 0,
			).length,
			riskTags,
		},
	};

	console.log(format === 'markdown' ? renderMarkdown(report) : JSON.stringify(report, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
