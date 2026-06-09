import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const WINDOWS_INSTALL_DIR_NAME = 'sharkord-preview';

export function resolveWindowsInstallDir() {
	const result = spawnSync('cmd.exe', ['/C', 'echo %LOCALAPPDATA%'], {
		encoding: 'utf8',
		cwd: '/mnt/c/Windows',
	});
	if (result.status !== 0) return null;
	const winPath = result.stdout.trim().split('\n').at(-1).trim();
	const wslPath = spawnSync('wslpath', ['-u', winPath], { encoding: 'utf8' });
	if (wslPath.status !== 0) return null;
	return path.join(wslPath.stdout.trim(), WINDOWS_INSTALL_DIR_NAME);
}

export function toWindowsPath(linuxPath) {
	const result = spawnSync('wslpath', ['-w', linuxPath], { encoding: 'utf8' });
	if (result.error || result.status !== 0) return null;
	return result.stdout.trim();
}
