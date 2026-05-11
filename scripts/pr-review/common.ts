import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface PromptSkillConfig {
	name: string;
	summary: string;
	when: string;
}

interface AnalyzerCommandConfig {
	name: string;
	command: string;
	allowedTool?: string;
	useWhen: string;
}

interface TypecheckErrorPatternConfig {
	pattern: string;
	flags: string;
}

export interface ReviewConfig {
	typescript: {
		rootTsconfig: string;
		workspaceDirs: string[];
		preferredTsconfigNames: string[];
		additionalTsconfigs: string[];
	};
	importGraph: {
		outputPath: string;
	};
	migrations: {
		directories: string[];
		fallbackPattern: string;
		dialect: string;
		statementBreakMarkers: string[];
	};
	trpc: {
		routersIndex: string;
		serverTsconfig: string;
		clientTsconfigs: string[];
		leaves: string[];
		routeAdapter: string;
		routerFactoryNames: string[];
	};
	typecheck: {
		defaultCommand: string;
		scopedCommandTemplate: string;
		timeoutMs: number;
		errorPatterns: TypecheckErrorPatternConfig[];
	};
	review: {
		repositoryLabel: string;
		highRiskAreas: string[];
		maxChangedFilesForFullReview: number;
		coreSkills: PromptSkillConfig[];
		repoSkills: PromptSkillConfig[];
		coreAnalyzers: AnalyzerCommandConfig[];
		repoAnalyzers: AnalyzerCommandConfig[];
		coreAllowedTools: string[];
		repoAllowedTools: string[];
		repoInvariants: string[];
		corePromptFragmentDirs: string[];
		repoPromptFragmentDirs: string[];
	};
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
	[key: string]: JsonValue;
}

const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
	typescript: {
		rootTsconfig: 'tsconfig.json',
		workspaceDirs: ['apps', 'packages'],
		preferredTsconfigNames: ['tsconfig.json'],
		additionalTsconfigs: [],
	},
	importGraph: {
		outputPath: '.pr-review-cache/import-graph.json',
	},
	migrations: {
		directories: [],
		fallbackPattern: '\\bmigrations?\\b.*\\.sql$',
		dialect: 'generic',
		statementBreakMarkers: [],
	},
	trpc: {
		routersIndex: '',
		serverTsconfig: '',
		clientTsconfigs: [],
		routeAdapter: 'object-literal-named-imports',
		routerFactoryNames: ['t.router'],
		leaves: [
			'mutate',
			'query',
			'mutation',
			'subscribe',
			'useQuery',
			'useMutation',
			'useSubscription',
			'useInfiniteQuery',
		],
	},
	typecheck: {
		defaultCommand: 'bun run check-types',
		scopedCommandTemplate: 'bun run --filter {{SCOPE}} check-types',
		timeoutMs: 5 * 60 * 1000,
		errorPatterns: [
			{
				pattern: '([^\\s:|]+\\.[mc]?tsx?)\\((\\d+),(\\d+)\\):\\s*error\\s+(TS\\d+):\\s*(.+)',
				flags: 'g',
			},
		],
	},
	review: {
		repositoryLabel: 'this repository',
		highRiskAreas: ['critical workflows'],
		maxChangedFilesForFullReview: 100,
		coreSkills: [],
		repoSkills: [],
		coreAnalyzers: [],
		repoAnalyzers: [],
		coreAllowedTools: [],
		repoAllowedTools: [],
		repoInvariants: [],
		corePromptFragmentDirs: ['scripts/pr-review/prompt-fragments'],
		repoPromptFragmentDirs: [],
	},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeConfig<T>(base: T, override: unknown): T {
	if (override === undefined) return base;
	if (Array.isArray(base)) {
		return (Array.isArray(override) ? override : base) as T;
	}
	if (isPlainObject(base) && isPlainObject(override)) {
		const out: Record<string, unknown> = { ...base };
		for (const [key, value] of Object.entries(override)) {
			out[key] = key in out ? mergeConfig(out[key], value) : value;
		}
		return out as T;
	}
	return override as T;
}

export function validateTypecheckErrorPatterns(config: ReviewConfig): void {
	const sampleError = 'src/example.ts(12,34): error TS1234: Sample typecheck failure';
	for (const [index, parser] of config.typecheck.errorPatterns.entries()) {
		const flags = parser.flags.includes('g') ? parser.flags : `${parser.flags}g`;
		let re: RegExp;
		try {
			re = new RegExp(parser.pattern, flags);
		} catch (error) {
			throw new Error(`Invalid typecheck.errorPatterns[${index}] regex: ${(error as Error).message}`);
		}

		const match = re.exec(sampleError);
		if (!match || match.length < 6) {
			throw new Error(
				`typecheck.errorPatterns[${index}] must capture file, line, column, TS code, and message in that order.`,
			);
		}
	}
}

export function findRepoRoot(start: string): string {
	let cur = resolve(start);
	while (cur !== '/') {
		if (existsSync(resolve(cur, '.git'))) return cur;
		cur = dirname(cur);
	}
	return resolve(start);
}

export function loadReviewConfig(repoRoot: string): ReviewConfig {
	const configPath = resolve(repoRoot, '.pr-review', 'review.config.json');
	if (!existsSync(configPath)) return DEFAULT_REVIEW_CONFIG;

	const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as JsonObject;
	return mergeConfig(DEFAULT_REVIEW_CONFIG, parsed);
}

export function renderTemplate(template: string, values: Record<string, string>): string {
	return template.replaceAll(/{{([A-Z0-9_]+)}}/g, (match, key: string) => values[key] ?? match);
}

export function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

export function mergeNamedByName<T extends { name: string }>(...groups: T[][]): T[] {
	const merged = new Map<string, T>();
	for (const group of groups) {
		for (const item of group) {
			merged.set(item.name, item);
		}
	}
	return [...merged.values()];
}
