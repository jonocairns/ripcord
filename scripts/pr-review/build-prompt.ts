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
	format: "text" | "json" | "allowed-tools";
} {
	let prNumber = process.env.PR_NUMBER ?? "";
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
		}
	}

	if (!prNumber) throw new Error("PR number is required via --pr or PR_NUMBER");

	return { prNumber, format };
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
	const { prNumber, format } = parseArgs(process.argv.slice(2));
	const repoRoot = findRepoRoot(process.cwd());
	const config = loadReviewConfig(repoRoot);
	const allowedTools = renderAllowedTools(config);
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
