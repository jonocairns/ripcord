import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'node:child_process';

const cwd = process.cwd();
const sidecarDir = path.resolve(cwd, 'sidecar');
const manifestPath = path.resolve(sidecarDir, 'Cargo.toml');
const args = process.argv.slice(2);

const isRelease = args.includes('--release');
const optional = args.includes('--optional');
const profile = isRelease ? 'release' : 'debug';
const binaryName =
  process.platform === 'win32'
    ? 'sharkord-capture-sidecar.exe'
    : 'sharkord-capture-sidecar';
const binarySourcePath = path.resolve(
  sidecarDir,
  'target',
  profile,
  binaryName
);
const binaryTargetPath = path.resolve(
  sidecarDir,
  'bin',
  process.platform,
  binaryName
);

const runCargoBuild = () => {
  const cargoCheck = spawnSync('cargo', ['--version'], {
    cwd: sidecarDir,
    stdio: 'pipe'
  });

  if (cargoCheck.error || cargoCheck.status !== 0) {
    if (optional) {
      console.warn(
        '[desktop] Rust sidecar build skipped: cargo is not installed.'
      );
      return false;
    }

    throw new Error(
      'cargo is required to build the capture sidecar. Install Rust toolchain first.'
    );
  }

  const buildArgs = ['build', '--manifest-path', manifestPath];

  if (isRelease) {
    buildArgs.push('--release');
  }

  const result = spawnSync('cargo', buildArgs, {
    cwd: sidecarDir,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    if (optional) {
      console.warn('[desktop] Rust sidecar build failed in optional mode.');
      return false;
    }

    throw new Error('Rust sidecar build failed.');
  }

  return true;
};

const copySidecarBinary = async () => {
  await fs.access(binarySourcePath);
  await fs.mkdir(path.dirname(binaryTargetPath), { recursive: true });
  await fs.copyFile(binarySourcePath, binaryTargetPath);

  if (process.platform !== 'win32') {
    await fs.chmod(binaryTargetPath, 0o755);
  }
};

const built = runCargoBuild();

if (built) {
  await copySidecarBinary();
  console.info(`[desktop] sidecar ready at ${binaryTargetPath}`);
}
