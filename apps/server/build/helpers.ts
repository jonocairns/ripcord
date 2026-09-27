import fs from 'node:fs/promises';
import path from 'node:path';
import type { TArtifact } from '@sharkord/shared';
import { type TReleaseMetadata, validateReleaseMetadata } from 'bun-sfe-autoupdater';

const buildScriptDir = import.meta.dir;
const serverCwd = path.resolve(buildScriptDir, '..');
const rootCwd = path.resolve(serverCwd, '..', '..');

const rootPckJson = path.join(rootCwd, 'package.json');
const serverPckJson = path.join(rootCwd, 'apps', 'server', 'package.json');

const unpack = async (tgzPath: string, outDir: string) => {
	const tarProc = Bun.spawn(['tar', '-xzf', tgzPath, '-C', outDir], {
		stdout: 'inherit',
		stderr: 'inherit',
		stdin: 'inherit',
	});
	await tarProc.exited;

	if (tarProc.exitCode !== 0) {
		throw new Error(`Failed to unpack ${tgzPath}`);
	}
};

const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_FETCH_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']);

const getErrorCode = (error: unknown) => {
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof (error as { code: unknown }).code === 'string'
	) {
		return (error as { code: string }).code;
	}

	return '';
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchArrayBufferWithRetry = async (url: string, attempts = 5): Promise<ArrayBuffer> => {
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const response = await fetch(url);

			if (!response.ok) {
				const retryableStatus = RETRYABLE_HTTP_STATUS_CODES.has(response.status);

				if (!retryableStatus || attempt === attempts) {
					throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
				}

				const waitMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);

				console.warn(
					`Download failed with HTTP ${response.status}. Retrying in ${waitMs}ms (attempt ${attempt}/${attempts})...`,
				);
				await sleep(waitMs);
				continue;
			}

			return await response.arrayBuffer();
		} catch (error) {
			const errorCode = getErrorCode(error);
			const retryableError = RETRYABLE_FETCH_ERROR_CODES.has(errorCode);

			if (!retryableError || attempt === attempts) {
				throw error;
			}

			const waitMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);

			console.warn(`Download failed with ${errorCode}. Retrying in ${waitMs}ms (attempt ${attempt}/${attempts})...`);
			await sleep(waitMs);
		}
	}

	throw new Error(`Failed to download ${url} after retries`);
};

const downloadMediasoupBinary = async (version: string, target: Bun.Build.Target) => {
	let url = `https://github.com/versatica/mediasoup/releases/download/${version}/`;
	let fileName = '';

	switch (target) {
		case 'bun-linux-x64':
			url += `mediasoup-worker-${version}-linux-x64-kernel6.tgz`;
			fileName = 'mediasoup-worker';
			break;
		case 'bun-windows-x64':
			url += `mediasoup-worker-${version}-win32-x64.tgz`;
			fileName = 'mediasoup-worker.exe';
			break;
		case 'bun-darwin-arm64':
			url += `mediasoup-worker-${version}-darwin-arm64.tgz`;
			fileName = 'mediasoup-worker';
			break;
		default:
			throw new Error(`Unsupported target for mediasoup binary: ${target}`);
	}

	const arrayBuffer = await fetchArrayBufferWithRetry(url);
	const buffer = Buffer.from(arrayBuffer);
	const targetPath = path.join(serverCwd, 'build', 'temp', `mediasoup-worker-${target}.tgz`);

	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.writeFile(targetPath, buffer);

	await unpack(targetPath, path.join(serverCwd, 'build', 'temp'));

	return fileName;
};

// When compiling for its host target, Bun copies its own executable into the
// output. Nix's Bun is patched to load its ELF interpreter from /nix/store, which
// would make the Linux release unrunnable outside Nix. Compile Linux from the
// upstream runtime instead, fetched from the same npm packages Bun uses for
// cross-compilation and pinned to the bundler's exact version.
const downloadPortableBunRuntime = async (target: Bun.Build.Target) => {
	if (target !== 'bun-linux-x64') {
		return undefined;
	}

	const packageName = '@oven/bun-linux-x64';
	const metadataUrl = `https://registry.npmjs.org/${packageName}/${Bun.version}`;
	const metadata = JSON.parse(new TextDecoder().decode(await fetchArrayBufferWithRetry(metadataUrl)));
	const tarballUrl: unknown = metadata?.dist?.tarball;
	const integrity: unknown = metadata?.dist?.integrity;

	if (typeof tarballUrl !== 'string' || typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
		throw new Error(`Missing tarball integrity for ${packageName}@${Bun.version}`);
	}

	const tarball = await fetchArrayBufferWithRetry(tarballUrl);
	const digest = Buffer.from(await crypto.subtle.digest('SHA-512', tarball)).toString('base64');

	if (`sha512-${digest}` !== integrity) {
		throw new Error(`Integrity mismatch for ${packageName}@${Bun.version}`);
	}

	const runtimeDir = path.join(serverCwd, 'build', 'temp', `bun-runtime-${target}`);
	const tarballPath = `${runtimeDir}.tgz`;

	await fs.mkdir(runtimeDir, { recursive: true });
	await fs.writeFile(tarballPath, Buffer.from(tarball));
	await unpack(tarballPath, runtimeDir);

	return path.join(runtimeDir, 'package', 'bin', 'bun');
};

const getCurrentVersion = async () => {
	if (process.env.SHARKORD_VERSION) {
		return process.env.SHARKORD_VERSION;
	}

	const pkg = JSON.parse(await fs.readFile(rootPckJson, 'utf8'));

	return pkg.version;
};

const getMediasoupVersion = async () => {
	const serverPkg = JSON.parse(await fs.readFile(serverPckJson, 'utf8'));

	return serverPkg.dependencies.mediasoup.replace('^', '');
};

type TTarget = {
	out: string;
	target: Bun.Build.Target;
};

const compile = async ({ out, target }: TTarget) => {
	const version = await getCurrentVersion();
	const mediasoupVersion = await getMediasoupVersion();
	const mediasoupBinary = await downloadMediasoupBinary(mediasoupVersion, target);
	const executablePath = await downloadPortableBunRuntime(target);

	const entryPoints = [
		path.join(serverCwd, 'src', 'index.ts'),
		path.join(serverCwd, 'build', 'temp', 'drizzle.zip'),
		path.join(serverCwd, 'build', 'temp', 'interface.zip'),
		path.join(serverCwd, 'build', 'temp', mediasoupBinary),
	];

	await Bun.build({
		entrypoints: entryPoints,
		compile: {
			outfile: out,
			target,
			...(executablePath ? { executablePath } : {}),
		},
		define: {
			'process.env.SHARKORD_ENV': '"production"',
			'process.env.SHARKORD_BUILD_VERSION': `"${version}"`,
			'process.env.SHARKORD_BUILD_DATE': `"${new Date().toISOString()}"`,
			'process.env.SHARKORD_MEDIASOUP_BIN_NAME': `"${mediasoupBinary}"`,
			'process.env.CURRENT_VERSION': `"${version}"`,
		},
	});
};

const getFileChecksum = async (filePath: string) => {
	const fileBuffer = await fs.readFile(filePath);
	const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

	return hashHex;
};

const getVersionInfo = async (targets: TTarget[], outPath: string): Promise<TReleaseMetadata> => {
	const version = await getCurrentVersion();

	const artifacts: TArtifact[] = [];

	for (const target of targets) {
		const artifactPath = path.join(outPath, target.out);

		artifacts.push({
			name: path.basename(artifactPath),
			target: target.target.replace('bun-', ''),
			size: (await fs.stat(artifactPath)).size,
			checksum: await getFileChecksum(artifactPath),
		});
	}

	const versionInfo = validateReleaseMetadata({
		version,
		releaseDate: new Date().toISOString(),
		artifacts,
	});

	return versionInfo;
};

const rmIfExists = async (filePath: string) => {
	try {
		await fs.access(filePath);
		await fs.rm(filePath);
	} catch {
		// ignore
	}
};

export type { TTarget };
export { compile, downloadMediasoupBinary, getCurrentVersion, getVersionInfo, rmIfExists };
