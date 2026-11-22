import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UpdateInfo } from 'electron-updater';
import { DesktopUpdater } from '../desktop-updater';

type TTimer = { callback: () => void; delayMs: number; repeat: boolean; cancelled: boolean; fired: boolean };

const updateInfo = (version: string): UpdateInfo => ({
	version,
	files: [{ url: `Ripcord.Desktop.Setup.${version}.exe`, sha512: 'abc==' }],
	path: `Ripcord.Desktop.Setup.${version}.exe`,
	sha512: 'abc==',
	releaseDate: '2026-11-22T00:00:00.000Z',
});

const updaterError = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

const flush = () => new Promise((resolve) => setImmediate(resolve));

const createHarness = ({
	withInstaller = true,
	metadataRejection = null,
	installerStarts = true,
}: {
	withInstaller?: boolean;
	metadataRejection?: string | null;
	installerStarts?: boolean;
} = {}) => {
	const timers: TTimer[] = [];
	const calls = { checks: 0, downloads: 0, quits: 0, relaunches: 0, installs: [] as [boolean, boolean][] };
	let rejectDownload: ((error: Error) => void) | undefined;

	const updater = new DesktopUpdater({
		getVersion: () => '2.6.6',
		quitApp: () => {
			calls.quits += 1;
		},
		relaunchApp: () => {
			calls.relaunches += 1;
		},
		checkForUpdates: async () => {
			calls.checks += 1;
		},
		verifyMetadata: () => metadataRejection,
		setTimer: (callback, delayMs, repeat) => {
			const timer: TTimer = { callback: () => {}, delayMs, repeat, cancelled: false, fired: false };
			timer.callback = () => {
				timer.fired = true;
				callback();
			};
			timers.push(timer);
			return {
				cancel: () => {
					timer.cancelled = true;
				},
			};
		},
		log: { log: () => {}, warn: () => {}, error: () => {} },
	});

	updater.enable(
		withInstaller
			? {
					downloadUpdate: () => {
						calls.downloads += 1;
						return new Promise((_resolve, reject) => {
							rejectDownload = reject;
						});
					},
					install: (isSilent, isForceRunAfter) => {
						calls.installs.push([isSilent, isForceRunAfter]);
						return installerStarts;
					},
				}
			: undefined,
	);

	// Mirrors electron-updater: the 'error' event fires, then the download
	// promise rejects.
	const failDownload = async (error: Error) => {
		updater.handleUpdateError(error);
		rejectDownload?.(error);
		await flush();
	};

	const pendingRetries = () => timers.filter((timer) => !timer.repeat && !timer.cancelled && !timer.fired);

	return { updater, calls, timers, failDownload, pendingRetries };
};

void describe('DesktopUpdater', () => {
	void it('downloads a verified update and skips further checks until it finishes', async () => {
		const { updater, calls } = createHarness();
		assert.equal(calls.checks, 1);

		updater.handleUpdateAvailable(updateInfo('2.7.0'));
		assert.equal(updater.getStatus().state, 'downloading');
		assert.equal(calls.downloads, 1);

		await updater.checkForUpdates();
		assert.equal(calls.checks, 1);

		updater.handleUpdateDownloaded(updateInfo('2.7.0'));
		await updater.checkForUpdates();
		assert.equal(updater.getStatus().state, 'downloaded');
		assert.equal(calls.checks, 1);
	});

	void it('restarts through the quit flow and installs once, relaunching the app', () => {
		const { updater, calls } = createHarness();
		updater.handleUpdateAvailable(updateInfo('2.7.0'));
		updater.handleUpdateDownloaded(updateInfo('2.7.0'));

		assert.equal(updater.restartToUpdate(), true);
		assert.equal(calls.quits, 1);
		assert.deepEqual(calls.installs, []);

		updater.installPendingUpdateBeforeQuit();
		updater.installPendingUpdateBeforeQuit();
		assert.deepEqual(calls.installs, [[true, true]]);
		assert.equal(calls.relaunches, 0);
	});

	void it('relaunches the current version when the installer cannot start', () => {
		const { updater, calls } = createHarness({ installerStarts: false });
		updater.handleUpdateAvailable(updateInfo('2.7.0'));
		updater.handleUpdateDownloaded(updateInfo('2.7.0'));

		updater.restartToUpdate();
		updater.installPendingUpdateBeforeQuit();
		assert.equal(calls.relaunches, 1);
	});

	void it('keeps a downloaded update ready when cache housekeeping fails afterwards', async () => {
		const { updater, failDownload } = createHarness();
		updater.handleUpdateAvailable(updateInfo('2.7.0'));
		updater.handleUpdateDownloaded(updateInfo('2.7.0'));
		await failDownload(updaterError('EPERM: operation not permitted, copyfile current.blockmap'));

		assert.equal(updater.getStatus().state, 'downloaded');
		assert.equal(updater.restartToUpdate(), true);
	});

	void it('leaves a plain quit to the install-on-quit handler', () => {
		const { updater, calls } = createHarness();
		updater.handleUpdateAvailable(updateInfo('2.7.0'));
		updater.handleUpdateDownloaded(updateInfo('2.7.0'));

		updater.installPendingUpdateBeforeQuit();
		assert.deepEqual(calls.installs, []);
	});

	void it('refuses to restart before an update has downloaded', () => {
		const { updater, calls } = createHarness();
		updater.handleUpdateAvailable(updateInfo('2.7.0'));

		assert.equal(updater.restartToUpdate(), false);
		assert.equal(calls.quits, 0);
	});

	void it('refuses unverified metadata without downloading or offering a download link', () => {
		const { updater, calls } = createHarness({ metadataRejection: 'Update metadata has no Ripcord signature.' });
		updater.handleUpdateAvailable(updateInfo('2.7.0'));

		assert.equal(calls.downloads, 0);
		assert.equal(updater.getStatus().state, 'error');
		assert.equal(updater.getStatus().unverified, true);
		assert.equal(updater.getStatus().manualInstallRequired, undefined);
	});

	void it('treats a replaced installer as unverified, not as a manual download', async () => {
		for (const error of [
			updaterError('sha512 checksum mismatch, expected abc, got def', 'ERR_CHECKSUM_MISMATCH'),
			updaterError('New version 2.7.0 is not signed by the application owner: bad', 'ERR_UPDATER_INVALID_SIGNATURE'),
		]) {
			const { updater, failDownload } = createHarness();
			updater.handleUpdateAvailable(updateInfo('2.7.0'));
			await failDownload(error);

			assert.equal(updater.getStatus().unverified, true);
			assert.equal(updater.getStatus().manualInstallRequired, undefined);
		}
	});

	void it('falls back to the manual installer when a download fails for another reason', async () => {
		const { updater, failDownload } = createHarness();
		updater.handleUpdateAvailable(updateInfo('2.7.0'));
		await failDownload(updaterError('ENOSPC: no space left on device'));

		assert.equal(updater.getStatus().state, 'available');
		assert.equal(updater.getStatus().manualInstallRequired, true);
	});

	void it('stops retrying a flaky download after the retry limit', async () => {
		const { updater, calls, failDownload, pendingRetries } = createHarness();

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			updater.handleUpdateAvailable(updateInfo('2.7.0'));
			await failDownload(updaterError('socket hang up'));

			const retries = pendingRetries();
			assert.equal(retries.length, 1);
			assert.equal(retries[0]?.delayMs, 15_000 * attempt);
			retries[0]?.callback();
			await flush();
			assert.equal(calls.checks, 1 + attempt);
		}

		updater.handleUpdateAvailable(updateInfo('2.7.0'));
		await failDownload(updaterError('socket hang up'));
		assert.equal(updater.getStatus().state, 'available');
		assert.equal(updater.getStatus().manualInstallRequired, true);
		assert.equal(calls.downloads, 4);
	});

	void it('keeps updates manual when verification is unavailable', () => {
		const { updater, calls } = createHarness({ withInstaller: false });
		updater.handleUpdateAvailable(updateInfo('2.7.0'));

		assert.equal(calls.downloads, 0);
		assert.equal(updater.getStatus().state, 'available');
		assert.equal(updater.getStatus().manualInstallRequired, true);
		assert.equal(updater.restartToUpdate(), false);
	});

	void it('clears the unverified flag and notes once no update is available', () => {
		const { updater } = createHarness({ metadataRejection: 'bad signature' });
		updater.handleUpdateAvailable(updateInfo('2.7.0'));
		updater.handleUpdateNotAvailable(updateInfo('2.6.6'));

		assert.equal(updater.getStatus().state, 'not-available');
		assert.equal(updater.getStatus().unverified, undefined);
		assert.equal(updater.getStatus().releaseNotes, undefined);
	});

	void it('rejects a downloaded file when no download is in progress', async () => {
		const { updater } = createHarness();
		assert.match((await updater.verifyDownloadedFile('installer.exe')) ?? '', /No update download/);
	});
});
