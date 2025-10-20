import type { TArtifact, TVersionInfo } from '@sharkord/shared';
import fs from 'fs/promises';
import path from 'path';

const serverCwd = process.cwd();
const rootCwd = path.resolve(serverCwd, '..', '..');

const rootPckJson = path.join(rootCwd, 'package.json');
const serverPckJson = path.join(rootCwd, 'apps', 'server', 'package.json');
const clientPckJson = path.join(rootCwd, 'apps', 'client', 'package.json');
const sharedPckJson = path.join(rootCwd, 'packages', 'shared', 'package.json');

const getCurrentVersion = async () => {
  const pkg = JSON.parse(await fs.readFile(rootPckJson, 'utf8'));

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

type TTarget = {
  out: string;
  target: Bun.Build.Target;
};

const compile = async ({ out, target }: TTarget) => {
  await Bun.build({
    entrypoints: [
      './src/index.ts',
      './build/temp/drizzle.zip',
      './build/temp/interface.zip'
    ],
    compile: {
      outfile: out,
      target
    },
    define: {
      SHARKORD_ENV: '"production"',
      SHARKORD_BUILD_VERSION: '"1.1.1"',
      SHARKORD_BUILD_DATE: `"${new Date().toISOString()}"`
    }
  });
};

const getFileChecksum = async (filePath: string) => {
  const fileBuffer = await fs.readFile(filePath);
  const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return hashHex;
};

const getVersionInfo = async (
  newVersion: string,
  targets: TTarget[],
  outPath: string
) => {
  const artifacts: TArtifact[] = [];

  for (const target of targets) {
    const artifactPath = path.join(outPath, target.out);

    artifacts.push({
      name: path.basename(artifactPath),
      target: target.target.replace('bun-', ''),
      size: (await fs.stat(artifactPath)).size,
      checksum: await getFileChecksum(artifactPath)
    });
  }

  const versionInfo: TVersionInfo = {
    version: newVersion,
    releaseDate: new Date().toISOString(),
    artifacts
  };

  return versionInfo;
};

export { compile, getCurrentVersion, getVersionInfo, patchPackageJsons };
export type { TTarget };
