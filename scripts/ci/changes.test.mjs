import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectChecks } from './changes.mjs';

test('native-only and documentation PRs skip JavaScript product checks', () => {
	assert.deepEqual(
		selectChecks(
			['apps/ios/Ripcord/VoiceClient.swift', 'apps/ios/project.yml', '.github/workflows/ios.yml', 'README.md'],
			'pull_request',
		),
		{ quality: false, product: false },
	);
	assert.deepEqual(selectChecks(['docs/releases.md', 'apps/client/README.md'], 'pull_request'), {
		quality: false,
		product: false,
	});
});

test('iOS fixtures still receive JavaScript quality checks but not web E2E or desktop builds', () => {
	for (const file of ['apps/ios/Tools/peer.ts', 'apps/ios/Tools/index.html', 'apps/ios/package.json']) {
		assert.deepEqual(selectChecks([file, 'apps/ios/Ripcord/VoiceBar.swift'], 'pull_request'), {
			quality: true,
			product: false,
		});
	}
});

test('product, dependency, CI and unknown paths retain all product checks even in mixed PRs', () => {
	for (const file of [
		'apps/server/src/index.ts',
		'apps/client/src/App.tsx',
		'apps/desktop/sidecar/src/main.rs',
		'packages/shared/src/index.ts',
		'bun.lock',
		'biome.json',
		'.github/workflows/pull-request.yml',
		'scripts/ci/changes.mjs',
		'future-workspace/code.ts',
	]) {
		assert.deepEqual(selectChecks(['apps/ios/Ripcord/VoiceBar.swift', file], 'pull_request'), {
			quality: true,
			product: true,
		});
	}
});

test('release and recovery checks never skip based on changed paths', () => {
	for (const event of ['push', 'workflow_dispatch', 'workflow_call']) {
		assert.deepEqual(selectChecks(['apps/ios/Ripcord/VoiceClient.swift'], event), { quality: true, product: true });
		assert.deepEqual(selectChecks([], event), { quality: true, product: true });
	}
});

test('CLI selects native-only, cross-boundary rename and release runs from real Git ranges', () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'ripcord-ci-'));
	const script = fileURLToPath(new URL('./changes.mjs', import.meta.url));
	const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
	try {
		git('init', '--quiet');
		git('config', 'user.name', 'CI test');
		git('config', 'user.email', 'ci-test@example.invalid');
		writeFileSync(path.join(directory, 'product\nfile.ts'), 'export const value = 1;\n');
		git('add', '.');
		git('commit', '--quiet', '-m', 'base');
		const base = git('rev-parse', 'HEAD');
		mkdirSync(path.join(directory, 'apps/ios'), { recursive: true });
		writeFileSync(path.join(directory, 'apps/ios/view.swift'), '// native view\n');
		git('add', '.');
		git('commit', '--quiet', '-m', 'native');
		const native = git('rev-parse', 'HEAD');
		renameSync(path.join(directory, 'product\nfile.ts'), path.join(directory, 'apps/ios/native.swift'));
		git('add', '-A');
		git('commit', '--quiet', '-m', 'move');
		for (const [event, head, expected] of [
			['pull_request', native, 'quality=false\nproduct=false\n'],
			['pull_request', git('rev-parse', 'HEAD'), 'quality=true\nproduct=true\n'],
			['push', '', 'quality=true\nproduct=true\n'],
		]) {
			const output = path.join(directory, 'output');
			writeFileSync(output, '');
			execFileSync(process.execPath, [script], {
				cwd: directory,
				env: {
					...process.env,
					GITHUB_EVENT_NAME: event,
					PR_BASE_SHA: base,
					PR_HEAD_SHA: head,
					GITHUB_OUTPUT: output,
				},
			});
			assert.equal(readFileSync(output, 'utf8'), expected);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
