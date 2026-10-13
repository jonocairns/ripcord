import fs from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';

// Packaged Electron can only load what electron-builder ships: Node built-ins,
// electron itself, and the runtime `dependencies` copied into app.asar. Workspace
// packages ship TypeScript source, so they must be bundled (devDependencies),
// never externalized; Electron refuses to strip types under node_modules.
const cwd = process.cwd();
const bundlePaths = ['dist/main/index.cjs', 'dist/preload/index.cjs'];
const requirePattern = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

const packageJson = JSON.parse(await fs.readFile(path.resolve(cwd, 'package.json'), 'utf8'));
const runtimeDependencies = Object.entries(packageJson.dependencies ?? {});
const allowedPackages = new Set(['electron', ...runtimeDependencies.map(([name]) => name)]);
const builtins = new Set(builtinModules);
const problems = [];

for (const [name, version] of runtimeDependencies) {
	if (String(version).startsWith('workspace:')) {
		problems.push(`${name} is a workspace package in "dependencies"; move it to "devDependencies" so tsup bundles it`);
	}
}

const toPackageName = (specifier) => {
	const parts = specifier.split('/');

	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

for (const bundlePath of bundlePaths) {
	const contents = await fs.readFile(path.resolve(cwd, bundlePath), 'utf8');

	for (const [, specifier] of contents.matchAll(requirePattern)) {
		if (specifier.startsWith('.') || specifier.startsWith('node:') || builtins.has(specifier)) {
			continue;
		}

		if (!allowedPackages.has(toPackageName(specifier))) {
			problems.push(`${bundlePath} requires "${specifier}", which is not a desktop runtime dependency`);
		}
	}
}

if (problems.length > 0) {
	console.error(`Desktop bundle check failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
	process.exit(1);
}

console.log(`Desktop bundle check passed (${bundlePaths.join(', ')})`);
