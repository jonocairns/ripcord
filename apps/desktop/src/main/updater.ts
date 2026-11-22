import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { autoUpdater, NsisUpdater } from 'electron-updater';
import { DesktopUpdater } from './desktop-updater';
import type { TDesktopUpdateStatus } from './types';

const APP_UPDATE_CONFIG_FILENAME = 'app-update.yml';

const readAppUpdateConfig = (): string | undefined => {
	try {
		return fs.readFileSync(path.join(process.resourcesPath, APP_UPDATE_CONFIG_FILENAME), 'utf8');
	} catch {
		return undefined;
	}
};

const updater = new DesktopUpdater({
	getVersion: () => app.getVersion(),
	quitApp: () => app.quit(),
	checkForUpdates: () => autoUpdater.checkForUpdates(),
});

let started = false;

const start = (listener: (status: TDesktopUpdateStatus) => void) => {
	updater.subscribe(listener);
	if (started) {
		return;
	}
	started = true;

	if (!app.isPackaged) {
		updater.markDisabled('Auto-update is disabled in development builds.');
		return;
	}

	if (process.platform === 'linux') {
		updater.markDisabled('Auto-update is not supported on Linux. Download the latest version from the releases page.');
		return;
	}

	if (process.platform === 'darwin') {
		updater.markDisabled(
			'Automatic updates are not yet available on macOS. Download the latest version from the releases page.',
		);
		return;
	}

	// Beta builds (0.0.0-beta.N) are not published to the stable update feed.
	if (app.getVersion().includes('-')) {
		updater.markDisabled('Automatic updates are not available for beta builds.');
		return;
	}

	const appUpdateConfig = readAppUpdateConfig();
	if (appUpdateConfig === undefined) {
		updater.markDisabled(
			'Auto-update metadata is missing (app-update.yml). Install the packaged desktop app to enable updates.',
		);
		return;
	}

	autoUpdater.autoDownload = false;
	autoUpdater.allowPrerelease = false;
	autoUpdater.autoInstallOnAppQuit = false;

	autoUpdater.on('checking-for-update', () => updater.handleCheckingForUpdate());
	autoUpdater.on('update-available', (info) => updater.handleUpdateAvailable(info));
	autoUpdater.on('update-not-available', (info) => updater.handleUpdateNotAvailable(info));
	autoUpdater.on('download-progress', (progress) => updater.handleDownloadProgress(progress));
	autoUpdater.on('update-downloaded', (info) => updater.handleUpdateDownloaded(info));
	autoUpdater.on('error', (error) => updater.handleUpdateError(error));

	// electron-updater only runs the signature hook when app-update.yml names a
	// publisher, so without one, updates stay manual instead of unverified.
	if (!(autoUpdater instanceof NsisUpdater) || !/^publisherName:/m.test(appUpdateConfig)) {
		console.warn('[desktop] Update verification is unavailable; updates must be installed manually.');
		updater.enable(undefined);
		return;
	}

	const nsisUpdater = autoUpdater;
	nsisUpdater.verifyUpdateCodeSignature = (_publisherNames, filePath) => updater.verifyDownloadedFile(filePath);
	// Web-installer packages are not covered by the update signature.
	nsisUpdater.disableWebInstaller = true;
	nsisUpdater.autoInstallOnAppQuit = true;
	updater.enable({
		downloadUpdate: () => nsisUpdater.downloadUpdate(),
		install: (isSilent, isForceRunAfter) => nsisUpdater.install(isSilent, isForceRunAfter),
	});
};

const desktopUpdater = {
	start,
	checkForUpdates: () => updater.checkForUpdates(),
	getStatus: () => updater.getStatus(),
	restartToUpdate: () => updater.restartToUpdate(),
	installPendingUpdateBeforeQuit: () => updater.installPendingUpdateBeforeQuit(),
	dispose: () => updater.dispose(),
};

export { desktopUpdater };
