#!/usr/bin/env bun
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import { findRepoRoot, loadReviewConfig } from './common';

interface RouteEntry {
	trpcPath: string;
	file: string;
	exportName: string;
}

interface CallSite {
	file: string;
	line: number;
	method: string;
}

interface CoverageReport {
	status: 'full' | 'degraded' | 'unsupported';
	adapter: string;
	notes: string[];
}

interface Report {
	repoRoot: string;
	generatedAt: string;
	pr: number | null;
	totalRoutes: number;
	totalCallSites: number;
	coverage: CoverageReport;
	routes: {
		trpcPath: string;
		file: string;
		exportName: string;
		callerCount: number;
		callers: CallSite[];
	}[];
	unmappedRouteFiles: string[];
}

interface RouterMappingResult {
	mapping: Record<string, string>;
	matchedFactoryName: string | null;
}

function parseArgs(argv: string[]): {
	pr: number | null;
	format: 'json' | 'markdown';
	route: string | null;
	all: boolean;
	files: string[];
} {
	const files: string[] = [];
	let pr: number | null = null;
	let format: 'json' | 'markdown' = 'markdown';
	let route: string | null = null;
	let all = false;
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
		} else if (a === '--route') {
			route = argv[++i] ?? null;
		} else if (a === '--all') {
			all = true;
		} else if (a && !a.startsWith('--')) {
			files.push(a);
		}
	}
	return { pr, format, route, all, files };
}

function getChangedFiles(pr: number): string[] {
	return execSync(`gh pr diff ${pr} --name-only`, { encoding: 'utf8' })
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseRouterMapping(sourceFile: SourceFile, routerFactoryNames: string[]): RouterMappingResult {
	const supportedFactories = new Set(routerFactoryNames);
	for (const ce of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		const exprText = ce.getExpression().getText();
		if (!supportedFactories.has(exprText)) continue;
		const arg = ce.getArguments()[0];
		if (!arg || !Node.isObjectLiteralExpression(arg)) {
			return { mapping: {}, matchedFactoryName: exprText };
		}
		const mapping: Record<string, string> = {};
		for (const prop of arg.getProperties()) {
			if (Node.isPropertyAssignment(prop)) {
				const key = prop.getName();
				const value = prop.getInitializer();
				if (value && Node.isIdentifier(value)) {
					mapping[key] = value.getText();
				}
			} else if (Node.isShorthandPropertyAssignment(prop)) {
				mapping[prop.getName()] = prop.getName();
			}
		}
		return { mapping, matchedFactoryName: exprText };
	}
	return { mapping: {}, matchedFactoryName: null };
}

function resolveImportedSymbol(sourceFile: SourceFile, name: string): SourceFile | null {
	for (const decl of sourceFile.getImportDeclarations()) {
		for (const ni of decl.getNamedImports()) {
			const localName = ni.getAliasNode()?.getText() ?? ni.getName();
			if (localName === name) {
				return decl.getModuleSpecifierSourceFile() ?? null;
			}
		}
	}
	return null;
}

function buildRouteMap(
	repoRoot: string,
	config: ReturnType<typeof loadReviewConfig>,
): {
	routes: RouteEntry[];
	unmapped: string[];
	coverage: CoverageReport;
} {
	const coverage: CoverageReport = {
		status: 'full',
		adapter: config.trpc.routeAdapter,
		notes: [],
	};

	if (config.trpc.routeAdapter !== 'object-literal-named-imports') {
		return {
			routes: [],
			unmapped: [],
			coverage: {
				status: 'unsupported',
				adapter: config.trpc.routeAdapter,
				notes: [
					`Unsupported tRPC route adapter "${config.trpc.routeAdapter}". Configure a supported adapter before using this analyzer in this repo.`,
				],
			},
		};
	}

	const tsconfig = resolve(repoRoot, config.trpc.serverTsconfig);
	if (!existsSync(tsconfig)) {
		return {
			routes: [],
			unmapped: [],
			coverage: {
				status: 'unsupported',
				adapter: config.trpc.routeAdapter,
				notes: [`Missing server tsconfig: ${config.trpc.serverTsconfig}`],
			},
		};
	}
	const project = new Project({ tsConfigFilePath: tsconfig });

	const rootPath = resolve(repoRoot, config.trpc.routersIndex);
	const rootFile = project.getSourceFile(rootPath) ?? project.addSourceFileAtPathIfExists(rootPath);
	if (!rootFile) {
		return {
			routes: [],
			unmapped: [],
			coverage: {
				status: 'unsupported',
				adapter: config.trpc.routeAdapter,
				notes: [`Missing router index: ${config.trpc.routersIndex}`],
			},
		};
	}

	const topMapping = parseRouterMapping(rootFile, config.trpc.routerFactoryNames);
	const routes: RouteEntry[] = [];
	const unmapped: string[] = [];

	if (topMapping.matchedFactoryName === null) {
		coverage.status = 'degraded';
		coverage.notes.push(
			`No supported router factory call found in ${config.trpc.routersIndex}. Expected one of: ${config.trpc.routerFactoryNames.join(', ')}.`,
		);
	} else if (Object.keys(topMapping.mapping).length === 0) {
		coverage.status = 'degraded';
		coverage.notes.push(
			`Root router uses ${topMapping.matchedFactoryName}, but not in the object-literal shape expected by the ${config.trpc.routeAdapter} adapter.`,
		);
	}

	for (const [topKey, subRouterName] of Object.entries(topMapping.mapping)) {
		const subFile = resolveImportedSymbol(rootFile, subRouterName);
		if (!subFile) {
			unmapped.push(`${topKey}: <${subRouterName}>`);
			continue;
		}
		const subMapping = parseRouterMapping(subFile, config.trpc.routerFactoryNames);
		if (subMapping.matchedFactoryName === null) {
			coverage.status = 'degraded';
			coverage.notes.push(`No supported router factory call found in ${relative(repoRoot, subFile.getFilePath())}.`);
			continue;
		}
		if (Object.keys(subMapping.mapping).length === 0) {
			coverage.status = 'degraded';
			coverage.notes.push(
				`${relative(repoRoot, subFile.getFilePath())} uses ${subMapping.matchedFactoryName}, but not in the object-literal shape expected by the ${config.trpc.routeAdapter} adapter.`,
			);
			continue;
		}
		for (const [routeKey, handlerName] of Object.entries(subMapping.mapping)) {
			const handlerFile = resolveImportedSymbol(subFile, handlerName);
			if (!handlerFile) {
				unmapped.push(`${topKey}.${routeKey}: <${handlerName}>`);
				continue;
			}
			routes.push({
				trpcPath: `${topKey}.${routeKey}`,
				file: relative(repoRoot, handlerFile.getFilePath()),
				exportName: handlerName,
			});
		}
	}

	if (unmapped.length > 0) {
		coverage.status = 'degraded';
		coverage.notes.push(
			`${unmapped.length} route entries could not be resolved through named imports; coverage is partial.`,
		);
	}

	return { routes, unmapped, coverage };
}

function extractCalleeChain(call: Node): { chain: string[]; leaf: string } | null {
	if (!Node.isCallExpression(call)) return null;
	const expr = call.getExpression();
	if (!Node.isPropertyAccessExpression(expr)) return null;
	const leaf = expr.getName();
	const segments: string[] = [];
	let cur: Node = expr.getExpression();
	while (Node.isPropertyAccessExpression(cur)) {
		segments.unshift(cur.getName());
		cur = cur.getExpression();
	}
	if (Node.isIdentifier(cur)) {
		segments.unshift(cur.getText());
	} else if (Node.isCallExpression(cur)) {
		segments.unshift('<call>');
	} else {
		segments.unshift('<expr>');
	}
	return { chain: segments, leaf };
}

function findCallSites(
	repoRoot: string,
	routes: RouteEntry[],
	config: ReturnType<typeof loadReviewConfig>,
): Map<string, CallSite[]> {
	const result = new Map<string, CallSite[]>();
	for (const route of routes) result.set(route.trpcPath, []);

	const routeIndex = new Map<string, RouteEntry>();
	for (const route of routes) routeIndex.set(route.trpcPath, route);
	const sortedPaths = [...routeIndex.keys()].sort((a, b) => b.split('.').length - a.split('.').length);

	const trpcLeaves = new Set(config.trpc.leaves);
	for (const tsconfigRel of config.trpc.clientTsconfigs) {
		const tsconfig = resolve(repoRoot, tsconfigRel);
		if (!existsSync(tsconfig)) continue;
		let project: Project;
		try {
			project = new Project({ tsConfigFilePath: tsconfig });
		} catch {
			continue;
		}
		for (const sf of project.getSourceFiles()) {
			const fp = sf.getFilePath();
			if (fp.includes('/node_modules/')) continue;
			if (!fp.startsWith(repoRoot)) continue;
			if (/\.(test|spec)\.tsx?$/.test(fp)) continue;
			if (/\bdist\b|\bbuild\b/.test(fp)) continue;
			for (const ce of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
				const extracted = extractCalleeChain(ce);
				if (!extracted) continue;
				if (!trpcLeaves.has(extracted.leaf)) continue;
				let matched: string | null = null;
				for (const path of sortedPaths) {
					const segments = path.split('.');
					const tail = extracted.chain.slice(-segments.length);
					if (tail.length === segments.length && tail.every((segment, i) => segment === segments[i])) {
						matched = path;
						break;
					}
				}
				if (!matched) continue;
				const rel = relative(repoRoot, fp);
				const callers = result.get(matched);
				if (!callers) continue;
				callers.push({
					file: rel,
					line: ce.getStartLineNumber(),
					method: extracted.leaf,
				});
			}
		}
	}
	return result;
}

function renderMarkdown(report: Report): string {
	const lines: string[] = [];
	lines.push('# tRPC edge report');
	lines.push('');
	lines.push(
		`Resolved **${report.totalRoutes}** route(s) with **${report.totalCallSites}** total client call site(s).`,
	);
	lines.push(`Coverage: **${report.coverage.status.toUpperCase()}** via \`${report.coverage.adapter}\``);
	lines.push('');
	for (const note of report.coverage.notes) {
		lines.push(`> ${note}`);
	}
	if (report.coverage.notes.length > 0) {
		lines.push('');
	}
	if (report.unmappedRouteFiles.length > 0) {
		lines.push(
			`> ${report.unmappedRouteFiles.length} entries could not be resolved (handler not imported via named import).`,
		);
		lines.push('');
	}
	if (report.routes.length === 0) {
		lines.push('_No routes in scope._');
		return lines.join('\n');
	}
	for (const route of report.routes) {
		lines.push(`## \`${route.trpcPath}\` → ${route.file}`);
		lines.push(`Export: \`${route.exportName}\` — **${route.callerCount}** caller(s)`);
		if (route.callers.length === 0) {
			lines.push('- _no client call sites found_');
		} else {
			for (const caller of route.callers) {
				lines.push(`- ${caller.file}:${caller.line} (.${caller.method})`);
			}
		}
		lines.push('');
	}
	return lines.join('\n');
}

async function main() {
	const { pr, format, route, all, files } = parseArgs(process.argv.slice(2));
	const repoRoot = findRepoRoot(process.cwd());
	const config = loadReviewConfig(repoRoot);

	const { routes, unmapped, coverage } = buildRouteMap(repoRoot, config);

	let scopedRoutes: RouteEntry[] = routes;
	if (route) {
		scopedRoutes = routes.filter((r) => r.trpcPath === route);
	} else if (!all) {
		let scope: string[] = files;
		if (pr !== null) {
			try {
				scope = scope.concat(getChangedFiles(pr));
			} catch (err) {
				console.error(`Failed to read PR ${pr}: ${(err as Error).message}`);
				process.exit(1);
			}
		}
		const scopeSet = new Set(scope.map((f) => (isAbsolute(f) ? relative(repoRoot, f) : f)));
		scopedRoutes = routes.filter((r) => scopeSet.has(r.file));
	}

	const callMap = findCallSites(repoRoot, scopedRoutes, config);

	const report: Report = {
		repoRoot,
		generatedAt: new Date().toISOString(),
		pr,
		totalRoutes: scopedRoutes.length,
		totalCallSites: 0,
		coverage,
		routes: scopedRoutes
			.map((r) => {
				const callers = callMap.get(r.trpcPath) ?? [];
				return {
					trpcPath: r.trpcPath,
					file: r.file,
					exportName: r.exportName,
					callerCount: callers.length,
					callers,
				};
			})
			.sort((a, b) => b.callerCount - a.callerCount),
		unmappedRouteFiles: unmapped,
	};
	report.totalCallSites = report.routes.reduce((acc, r) => acc + r.callerCount, 0);

	console.log(format === 'markdown' ? renderMarkdown(report) : JSON.stringify(report, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
