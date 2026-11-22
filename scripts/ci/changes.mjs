import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Native-only and documentation changes do not feed the JavaScript product builds. */
export function selectChecks(files, eventName) {
	// Release/recovery callers always check their complete verified source commit.
	if (eventName !== 'pull_request') return { quality: true, product: true };
	let quality = false;
	let product = false;
	for (const file of files) {
		if (file.startsWith('docs/') || file.endsWith('.md')) continue;
		if (file.startsWith('apps/ios/Tools/') || file === 'apps/ios/package.json') {
			quality = true;
		} else if (!file.startsWith('apps/ios/') && file !== '.github/workflows/ios.yml') {
			// Unknown/global paths deliberately retain every existing product check.
			quality = true;
			product = true;
		}
	}
	return { quality, product };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	let files = [];
	if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
		const { PR_BASE_SHA, PR_HEAD_SHA } = process.env;
		if (![PR_BASE_SHA, PR_HEAD_SHA].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ''))) {
			throw new Error('Pull request change detection requires immutable base and head SHAs.');
		}
		// No API/file-count cap; NUL delimiters handle whitespace, and disabling
		// rename detection includes both the old and new sides of a move.
		files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${PR_BASE_SHA}...${PR_HEAD_SHA}`], {
			encoding: 'utf8',
		})
			.split('\0')
			.filter(Boolean);
	}
	const checks = selectChecks(files, process.env.GITHUB_EVENT_NAME);
	const output = Object.entries(checks)
		.map(([name, enabled]) => `${name}=${enabled}\n`)
		.join('');
	appendFileSync(process.env.GITHUB_OUTPUT, output);
	console.log(output.trim());
}
