import fs from 'fs/promises';
import path from 'path';

const serverCwd = process.cwd();
const rootCwd = path.resolve(serverCwd, '..', '..');

console.log({ serverCwd, rootCwd });

const rootPckJson = path.join(rootCwd, 'package.json');
const serverPckJson = path.join(rootCwd, 'apps', 'server', 'package.json');
const clientPckJson = path.join(rootCwd, 'apps', 'client', 'package.json');
const sharedPckJson = path.join(rootCwd, 'packages', 'shared', 'package.json');

const getCurrentVersion = async () => {
  const pkg = JSON.parse(await fs.readFile(rootPckJson, 'utf8'));

  console.log(`Current version: ${pkg.version}`);

  return pkg.version;
};

const patchPackageJsons = async (newVersion: string) => {
  const packageJsonPaths = [
    rootPckJson,
    serverPckJson,
    clientPckJson,
    sharedPckJson
  ];

  for (const pckPath of packageJsonPaths) {
    const pkg = JSON.parse(await fs.readFile(pckPath, 'utf8'));

    pkg.version = newVersion;

    await fs.writeFile(pckPath, JSON.stringify(pkg, null, 2), 'utf8');
  }
};

export { getCurrentVersion, patchPackageJsons };
