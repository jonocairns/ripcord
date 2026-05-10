#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	type CallExpression,
	type ExportedDeclarations,
	Node,
	Project,
	type SourceFile,
} from "ts-morph";
import { findRepoRoot, loadReviewConfig } from "./common";

interface CallerLocation {
	file: string;
	line: number;
}

interface CallShape {
	// How many references appear in callee position (i.e. `symbol(...)` rather
	// than being passed as a value). May be lower than callerCount when the
	// symbol is also imported as a type or stored in a variable.
	calleeCount: number;
	// Of those, how many have an object-literal as their first argument — the
	// only shape we can statically inspect.
	objectLiteralCount: number;
	// Map of property-name → number of object-literal calls that pass it.
	keyCounts: Record<string, number>;
}

interface SymbolImpact {
	name: string;
	kind: string;
	callerCount: number;
	callers: CallerLocation[];
	truncated: boolean;
	shape?: CallShape;
}

interface FileImpact {
	file: string;
	tsconfig: string | null;
	exportedSymbolCount: number;
	symbols: SymbolImpact[];
	error?: string;
}

interface ImpactReport {
	repoRoot: string;
	generatedAt: string;
	files: FileImpact[];
	summary: {
		totalFiles: number;
		totalSymbols: number;
		totalCallers: number;
		highImpactSymbols: { file: string; symbol: string; callers: number }[];
	};
}

const MAX_CALLERS_PER_SYMBOL = 25;
const HIGH_IMPACT_THRESHOLD = 10;

function findNearestTsconfig(
	filePath: string,
	repoRoot: string,
	config: ReturnType<typeof loadReviewConfig>,
): string | null {
	let cur = dirname(resolve(filePath));
	while (cur.startsWith(repoRoot) && cur !== "/") {
		for (const configName of config.typescript.preferredTsconfigNames) {
			const candidate = resolve(cur, configName);
			if (existsSync(candidate)) return candidate;
		}
		cur = dirname(cur);
	}
	const rootCandidate = resolve(repoRoot, config.typescript.rootTsconfig);
	return existsSync(rootCandidate) ? rootCandidate : null;
}

function parseArgs(argv: string[]): { files: string[]; pr: number | null; format: "json" | "markdown" } {
	const files: string[] = [];
	let pr: number | null = null;
	let format: "json" | "markdown" = "json";
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--pr") {
			const next = argv[++i];
			if (!next) throw new Error("--pr requires a value");
			pr = Number.parseInt(next, 10);
			if (Number.isNaN(pr)) throw new Error("--pr must be a number");
		} else if (arg === "--files") {
			const next = argv[++i];
			if (!next) throw new Error("--files requires a value");
			for (const f of next.split(",")) files.push(f.trim());
		} else if (arg === "--format") {
			const next = argv[++i];
			if (next !== "json" && next !== "markdown") throw new Error("--format must be json|markdown");
			format = next;
		} else if (arg && !arg.startsWith("--")) {
			files.push(arg);
		}
	}
	return { files, pr, format };
}

function getChangedFilesFromPr(pr: number): string[] {
	const out = execSync(`gh pr diff ${pr} --name-only`, { encoding: "utf8" });
	return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function isAnalyzable(file: string): boolean {
	if (!/\.(ts|tsx|mts|cts)$/.test(file)) return false;
	if (/\.d\.ts$/.test(file)) return false;
	if (/\bnode_modules\b/.test(file)) return false;
	if (/\bdist\b|\bbuild\b/.test(file)) return false;
	if (/\.(test|spec)\.tsx?$/.test(file)) return false;
	return true;
}

// Walk up from a reference identifier to the CallExpression it serves as the
// callee for, if any. Permits passing through one PropertyAccessExpression so
// that `obj.fn()` calls of a re-exported symbol still register.
function findCallExprForRef(refNode: Node): CallExpression | null {
	let cur: Node = refNode;
	for (let i = 0; i < 6; i++) {
		const parent: Node | undefined = cur.getParent();
		if (!parent) return null;
		if (Node.isCallExpression(parent)) {
			return parent.getExpression() === cur ? parent : null;
		}
		if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === cur) {
			cur = parent;
			continue;
		}
		return null;
	}
	return null;
}

function extractObjectLiteralKeys(call: CallExpression): string[] | null {
	const args = call.getArguments();
	if (args.length === 0) return null;
	const first = args[0];
	if (!first || !Node.isObjectLiteralExpression(first)) return null;
	const keys: string[] = [];
	for (const p of first.getProperties()) {
		if (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) {
			const name = p.getName();
			if (name) keys.push(name);
		} else if (Node.isSpreadAssignment(p)) {
			keys.push("...spread");
		}
	}
	return keys;
}

function declarationKind(decl: Node): string {
	if (Node.isFunctionDeclaration(decl)) return "function";
	if (Node.isClassDeclaration(decl)) return "class";
	if (Node.isInterfaceDeclaration(decl)) return "interface";
	if (Node.isTypeAliasDeclaration(decl)) return "type";
	if (Node.isEnumDeclaration(decl)) return "enum";
	if (Node.isVariableDeclaration(decl)) return "variable";
	return decl.getKindName();
}

function analyzeFile(
	sourceFile: SourceFile,
	repoRoot: string,
): SymbolImpact[] {
	const exports = sourceFile.getExportedDeclarations();
	const out: SymbolImpact[] = [];
	const sourceFilePath = sourceFile.getFilePath();

	for (const [name, decls] of exports) {
		const decl: ExportedDeclarations | undefined = decls[0];
		if (!decl) continue;
		const callers: CallerLocation[] = [];
		const seen = new Set<string>();
		let truncated = false;
		let calleeCount = 0;
		let objectLiteralCount = 0;
		const keyCounts: Record<string, number> = {};

		const refNode = Node.isVariableDeclaration(decl)
			? decl.getNameNode()
			: Node.hasName(decl)
				? decl.getNameNode()
				: undefined;
		if (!refNode || !Node.isReferenceFindable(refNode)) continue;

		try {
			const refs = refNode.findReferences();
			for (const refSymbol of refs) {
				for (const ref of refSymbol.getReferences()) {
					const refFile = ref.getSourceFile().getFilePath();
					if (refFile === sourceFilePath) continue;
					const refIdent = ref.getNode();
					const start = refIdent.getStartLineNumber();

					// Shape sampling runs on every external ref, even after the caller
					// list is truncated — gives accurate aggregate counts on big symbols.
					const callExpr = findCallExprForRef(refIdent);
					if (callExpr) {
						calleeCount++;
						const keys = extractObjectLiteralKeys(callExpr);
						if (keys !== null) {
							objectLiteralCount++;
							for (const k of keys) {
								keyCounts[k] = (keyCounts[k] ?? 0) + 1;
							}
						}
					}

					const key = `${refFile}:${start}`;
					if (seen.has(key)) continue;
					seen.add(key);
					if (callers.length >= MAX_CALLERS_PER_SYMBOL) {
						truncated = true;
						continue;
					}
					callers.push({
						file: relative(repoRoot, refFile),
						line: start,
					});
				}
			}
		} catch {
			// Reference resolution can fail on malformed code or missing context;
			// surface zero callers rather than aborting the whole report.
			callers.length = 0;
		}

		const shape: CallShape | undefined = calleeCount > 0
			? { calleeCount, objectLiteralCount, keyCounts }
			: undefined;

		out.push({
			name,
			kind: declarationKind(decl),
			callerCount: seen.size,
			callers,
			truncated,
			shape,
		});
	}

	out.sort((a, b) => b.callerCount - a.callerCount);
	return out;
}

function buildProject(tsconfigPath: string): Project {
	return new Project({
		tsConfigFilePath: tsconfigPath,
		skipAddingFilesFromTsConfig: false,
		skipFileDependencyResolution: false,
	});
}

function renderMarkdown(report: ImpactReport): string {
	const lines: string[] = [];
	lines.push(`# PR impact report`);
	lines.push("");
	lines.push(
		`Analyzed **${report.summary.totalFiles}** files, **${report.summary.totalSymbols}** exported symbols, **${report.summary.totalCallers}** total external callers.`,
	);
	lines.push("");

	if (report.summary.highImpactSymbols.length > 0) {
		lines.push(`## High-impact symbols (>= ${HIGH_IMPACT_THRESHOLD} callers)`);
		lines.push("");
		for (const h of report.summary.highImpactSymbols) {
			lines.push(`- \`${h.symbol}\` (${h.file}) — **${h.callers}** callers`);
		}
		lines.push("");
	}

	for (const f of report.files) {
		lines.push(`## ${f.file}`);
		if (f.error) {
			lines.push(`> error: ${f.error}`);
			continue;
		}
		if (f.symbols.length === 0) {
			lines.push("> no exported symbols");
			continue;
		}
		for (const s of f.symbols) {
			const truncated = s.truncated ? " (truncated)" : "";
			lines.push(`- \`${s.name}\` (${s.kind}) — ${s.callerCount} callers${truncated}`);
			for (const c of s.callers.slice(0, 5)) {
				lines.push(`  - ${c.file}:${c.line}`);
			}
			if (s.callers.length > 5) {
				lines.push(`  - ...and ${s.callers.length - 5} more`);
			}
			if (s.shape && s.shape.objectLiteralCount > 0) {
				const sortedKeys = Object.entries(s.shape.keyCounts).sort((a, b) => b[1] - a[1]);
				lines.push(
					`  - first-arg shape: ${s.shape.objectLiteralCount}/${s.shape.calleeCount} call(s) pass an object literal`,
				);
				for (const [k, n] of sortedKeys) {
					lines.push(`    - \`${k}\`: ${n}/${s.shape.objectLiteralCount}`);
				}
			}
		}
		lines.push("");
	}

	return lines.join("\n");
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
		.filter((f) => isAnalyzable(f));

	if (files.length === 0) {
		const empty: ImpactReport = {
			repoRoot,
			generatedAt: new Date().toISOString(),
			files: [],
			summary: {
				totalFiles: 0,
				totalSymbols: 0,
				totalCallers: 0,
				highImpactSymbols: [],
			},
		};
		console.log(format === "markdown" ? renderMarkdown(empty) : JSON.stringify(empty, null, 2));
		return;
	}

	const filesByTsconfig = new Map<string, string[]>();
	for (const file of files) {
		const tsconfig = findNearestTsconfig(file, repoRoot, config);
		if (!tsconfig) continue;
		const arr = filesByTsconfig.get(tsconfig) ?? [];
		arr.push(file);
		filesByTsconfig.set(tsconfig, arr);
	}

	const fileReports: FileImpact[] = [];
	for (const [tsconfig, group] of filesByTsconfig) {
		try {
			const project = buildProject(tsconfig);
			for (const file of group) {
				const sf = project.getSourceFile(file) ?? project.addSourceFileAtPathIfExists(file);
				if (!sf) {
					fileReports.push({
						file: relative(repoRoot, file),
						tsconfig: relative(repoRoot, tsconfig),
						exportedSymbolCount: 0,
						symbols: [],
						error: "could not load source file",
					});
					continue;
				}
				const symbols = analyzeFile(sf, repoRoot);
				fileReports.push({
					file: relative(repoRoot, file),
					tsconfig: relative(repoRoot, tsconfig),
					exportedSymbolCount: symbols.length,
					symbols,
				});
			}
		} catch (err) {
			for (const file of group) {
				fileReports.push({
					file: relative(repoRoot, file),
					tsconfig: relative(repoRoot, tsconfig),
					exportedSymbolCount: 0,
					symbols: [],
					error: `project load failed: ${(err as Error).message}`,
				});
			}
		}
	}

	const totalSymbols = fileReports.reduce((acc, f) => acc + f.symbols.length, 0);
	const totalCallers = fileReports.reduce(
		(acc, f) => acc + f.symbols.reduce((a, s) => a + s.callerCount, 0),
		0,
	);
	const highImpact = fileReports
		.flatMap((f) =>
			f.symbols
				.filter((s) => s.callerCount >= HIGH_IMPACT_THRESHOLD)
				.map((s) => ({ file: f.file, symbol: s.name, callers: s.callerCount })),
		)
		.sort((a, b) => b.callers - a.callers);

	const report: ImpactReport = {
		repoRoot,
		generatedAt: new Date().toISOString(),
		files: fileReports,
		summary: {
			totalFiles: fileReports.length,
			totalSymbols,
			totalCallers,
			highImpactSymbols: highImpact,
		},
	};

	console.log(format === "markdown" ? renderMarkdown(report) : JSON.stringify(report, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
