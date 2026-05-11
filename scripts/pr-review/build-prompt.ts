#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	findRepoRoot,
	loadReviewConfig,
	mergeNamedByName,
	renderTemplate,
	uniqueStrings,
} from "./common";

function parseArgs(argv: string[]): {
	prNumber: string;
	changedFilesCount: number | null;
	format: "text" | "json" | "allowed-tools";
} {
	let prNumber = process.env.PR_NUMBER ?? "";
	const envChangedFiles = process.env.PR_CHANGED_FILES;
	let changedFilesCount =
		envChangedFiles && /^\d+$/.test(envChangedFiles)
			? Number.parseInt(envChangedFiles, 10)
			: null;
	let format: "text" | "json" | "allowed-tools" = "text";

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--pr") {
			const next = argv[++i];
			if (!next) throw new Error("--pr requires a value");
			prNumber = next;
		} else if (arg === "--format") {
			const next = argv[++i];
			if (next !== "text" && next !== "json" && next !== "allowed-tools") {
				throw new Error("--format must be text|json|allowed-tools");
			}
			format = next;
		} else if (arg === "--changed-files") {
			const next = argv[++i];
			if (!next) throw new Error("--changed-files requires a value");
			const parsed = Number.parseInt(next, 10);
			if (Number.isNaN(parsed) || parsed < 0) {
				throw new Error("--changed-files must be a non-negative integer");
			}
			changedFilesCount = parsed;
		}
	}

	if (!prNumber) throw new Error("PR number is required via --pr or PR_NUMBER");

	return { prNumber, changedFilesCount, format };
}

function readPromptFragments(repoRoot: string, fragmentDirs: string[]): string[] {
	const fragments: string[] = [];
	for (const relDir of fragmentDirs) {
		const absDir = resolve(repoRoot, relDir);
		if (!existsSync(absDir)) continue;
		const files = readdirSync(absDir)
			.filter((name) => name.endsWith(".md"))
			.sort((a, b) => a.localeCompare(b));
		for (const file of files) {
			fragments.push(readFileSync(resolve(absDir, file), "utf8").trim());
		}
	}
	return fragments;
}

function getSkills(config: ReturnType<typeof loadReviewConfig>) {
	return mergeNamedByName(config.review.coreSkills, config.review.repoSkills);
}

function getAnalyzers(config: ReturnType<typeof loadReviewConfig>) {
	return mergeNamedByName(config.review.coreAnalyzers, config.review.repoAnalyzers);
}

function renderSkills(config: ReturnType<typeof loadReviewConfig>): string {
	const skills = getSkills(config);
	if (skills.length === 0) return "- None configured.";
	return skills
		.map((skill) => `- \`${skill.name}\` — ${skill.summary} ${skill.when}`)
		.join("\n");
}

function renderAnalyzerCommands(
	config: ReturnType<typeof loadReviewConfig>,
	prNumber: string,
): string {
	const analyzers = getAnalyzers(config);
	if (analyzers.length === 0) return "- None configured.";
	return analyzers
		.map((adapter) => {
			const command = renderTemplate(adapter.command, { PR_NUMBER: prNumber });
			return `- \`${adapter.name}\` → \`${command}\` (${adapter.useWhen})`;
		})
		.join("\n");
}

function renderRepoInvariants(config: ReturnType<typeof loadReviewConfig>): string {
	if (config.review.repoInvariants.length === 0) return "- None configured.";
	return config.review.repoInvariants.map((item) => `- ${item}`).join("\n");
}

function renderReviewScope(
	config: ReturnType<typeof loadReviewConfig>,
	changedFilesCount: number | null,
): {
	changedFilesCount: string;
	fullReviewFileLimit: string;
	reviewScopeGuidance: string;
} {
	const limit = config.review.maxChangedFilesForFullReview;
	if (changedFilesCount === null) {
		return {
			changedFilesCount: "unknown",
			fullReviewFileLimit: String(limit),
			reviewScopeGuidance:
				`The changed-file count was not precomputed. If PR metadata shows more than ${limit} changed files, switch to scoped review: run applicable deterministic analyzers, focus reads and inline comments on the highest-risk files only (${config.review.highRiskAreas.join(", ")}), and say explicitly in the final summary that coverage was scoped due to PR size.`,
		};
	}

	if (changedFilesCount > limit) {
		return {
			changedFilesCount: String(changedFilesCount),
			fullReviewFileLimit: String(limit),
			reviewScopeGuidance:
				`This PR changes ${changedFilesCount} files, exceeding the full-review limit of ${limit}. Do not attempt full file-by-file coverage. Run applicable deterministic analyzers, then focus reads and inline comments on the highest-risk files only (${config.review.highRiskAreas.join(", ")}). State explicitly in the final summary that coverage was scoped due to PR size.`,
		};
	}

	return {
		changedFilesCount: String(changedFilesCount),
		fullReviewFileLimit: String(limit),
		reviewScopeGuidance:
			`This PR changes ${changedFilesCount} files, which is within the full-review limit of ${limit}. Review normally, but still prioritize the highest-risk areas first (${config.review.highRiskAreas.join(", ")}).`,
	};
}

function renderAllowedTools(config: ReturnType<typeof loadReviewConfig>): string {
	return uniqueStrings([
		...config.review.coreAllowedTools,
		...config.review.repoAllowedTools,
		...getAnalyzers(config).flatMap((adapter) =>
			adapter.allowedTool ? [adapter.allowedTool] : [],
		),
	]).join(",");
}

async function main() {
	const { prNumber, changedFilesCount, format } = parseArgs(process.argv.slice(2));
	const repoRoot = findRepoRoot(process.cwd());
	const config = loadReviewConfig(repoRoot);
	const allowedTools = renderAllowedTools(config);
	const reviewScope = renderReviewScope(config, changedFilesCount);
	const fragments = readPromptFragments(repoRoot, [
		...config.review.corePromptFragmentDirs,
		...config.review.repoPromptFragmentDirs,
	]);

	if (fragments.length === 0 && format !== "allowed-tools") {
		throw new Error("No prompt fragments found.");
	}

	const prompt = renderTemplate(fragments.join("\n\n"), {
		PR_NUMBER: prNumber,
		REPOSITORY_LABEL: config.review.repositoryLabel,
		HIGH_RISK_AREAS: config.review.highRiskAreas.join(", "),
		CHANGED_FILES_COUNT: reviewScope.changedFilesCount,
		FULL_REVIEW_FILE_LIMIT: reviewScope.fullReviewFileLimit,
		REVIEW_SCOPE_GUIDANCE: reviewScope.reviewScopeGuidance,
		SKILLS: renderSkills(config),
		ANALYZER_COMMANDS: renderAnalyzerCommands(config, prNumber),
		REPO_INVARIANTS: renderRepoInvariants(config),
	});

	if (format === "allowed-tools") {
		console.log(allowedTools);
		return;
	}

	if (format === "json") {
		console.log(JSON.stringify({ prompt, allowedTools }, null, 2));
		return;
	}

	console.log(prompt);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
