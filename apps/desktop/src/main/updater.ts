import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { autoUpdater, NsisUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { TDesktopUpdateStatus } from './types';
import { resolveReleaseNotes } from './update-release-notes';
import { verifyDownloadedUpdate, verifyUpdateMetadata } from './update-verification';

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const APP_UPDATE_CONFIG_FILENAME = 'app-update.yml';
const MAX_UPDATE_ERROR_MESSAGE_LENGTH = 280;
const UPDATE_VERIFICATION_ERROR_PATTERN =
	/ERR_UPDATER_INVALID_SIGNATURE|not signed by the application owner|sign verification failed/i;
const UNVERIFIED_UPDATE_MESSAGE = 'This update could not be verified, so it was not installed.';

const TRANSIENT_ERROR_PATTERN =
	/ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|network|502|503|504|429|Bad Gateway|Service Unavailable|Gateway Timeout/i;

const MAX_TRANSIENT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 15_000;

type TStatusListener = (status: TDesktopUpdateStatus) => void;

const createBaseStatus = (): TDesktopUpdateStatus => ({
	state: 'idle',
	currentVersion: app.getVersion(),
});

const readAppUpdateConfig = (): string | undefined => {
	const appUpdateConfigPath = path.join(process.resourcesPath, APP_UPDATE_CONFIG_FILENAME);

	try {
		return fs.readFileSync(appUpdateConfigPath, 'utf8');
	} catch {
		return undefined;
	}
};

const resolveUserFacingUpdateErrorMessage = (error: Error): string => {
	const rawMessage = error.message?.trim() || 'Unknown updater error.';
	const normalized = rawMessage.replace(/\s+/g, ' ').trim();

	if (UPDATE_VERIFICATION_ERROR_PATTERN.test(normalized)) {
		return UNVERIFIED_UPDATE_MESSAGE;
	}

	const withoutRawInfo = normalized.replace(/\s*raw info:\s*.+$/i, '');
	const compact = withoutRawInfo || normalized;
	if (compact.length <= MAX_UPDATE_ERROR_MESSAGE_LENGTH) {
		return compact;
	}

	return `${compact.slice(0, MAX_UPDATE_ERROR_MESSAGE_LENGTH - 1)}…`;
};

const isTransientError = (error: Error): boolean => {
	const rawMessage = error.message?.trim() || '';
	if (UPDATE_VERIFICATION_ERROR_PATTERN.test(rawMessage)) {
		return false;
	}
	return TRANSIENT_ERROR_PATTERN.test(rawMessage);
};

class DesktopUpdater {
	private status: TDesktopUpdateStatus = createBaseStatus();
	private initialized = false;
	private enabled = false;
	private statusListener?: TStatusListener;
	private intervalHandle?: NodeJS.Timeout;
	private retryHandle?: NodeJS.Timeout;
	private consecutiveTransientFailures = 0;
	private nsisUpdater?: NsisUpdater;
	// The update being downloaded. The signature check reads it because
	// electron-updater only passes the downloaded file's path.
	private downloadingInfo?: UpdateInfo;
	private downloadInFlight = false;
	private restartRequested = false;

	private emitStatus(update: TDesktopUpdateStatus) {
		this.status = update;
		this.statusListener?.(this.status);
	}

	private setStatus(next: Partial<TDesktopUpdateStatus>) {
		this.emitStatus({
			...this.status,
			...next,
			currentVersion: app.getVersion(),
		});
	}

	private handleUpdateAvailable(info: UpdateInfo) {
		const releaseNotes = resolveReleaseNotes({
			info,
			currentVersion: app.getVersion(),
			availableVersion: info.version,
		});

		// Builds whose app-update.yml would skip verification keep the manual
		// download.
		if (!this.nsisUpdater) {
			this.consecutiveTransientFailures = 0;
			this.setStatus({
				state: 'available',
				availableVersion: info.version,
				manualInstallRequired: true,
				checkedAtIso: new Date().toISOString(),
				message: undefined,
				releaseNotes,
			});
			return;
		}

		// Every release after this build is signed, so a missing or invalid
		// signature means the release assets were altered. Offer no download link:
		// it would point at the same unverified installer.
		const rejection = verifyUpdateMetadata(info);
		if (rejection) {
			console.error('[desktop] Rejected unverified update', { version: info.version, reason: rejection });
			this.setStatus({
				state: 'error',
				availableVersion: info.version,
				manualInstallRequired: undefined,
				checkedAtIso: new Date().toISOString(),
				percent: undefined,
				bytesPerSecond: undefined,
				message: UNVERIFIED_UPDATE_MESSAGE,
				releaseNotes: undefined,
			});
			return;
		}

		// The retry counter is not reset here: each download retry re-checks for
		// updates, so resetting would retry a failing download forever.
		this.downloadingInfo = info;
		this.downloadInFlight = true;
		this.setStatus({
			state: 'downloading',
			availableVersion: info.version,
			manualInstallRequired: undefined,
			checkedAtIso: new Date().toISOString(),
			percent: 0,
			bytesPerSecond: undefined,
			transferredBytes: undefined,
			totalBytes: undefined,
			message: undefined,
			releaseNotes,
		});

		void this.nsisUpdater
			.downloadUpdate()
			.catch(() => {
				// Download failures also arrive through the 'error' event.
			})
			.finally(() => {
				this.downloadInFlight = false;
			});
	}

	private handleDownloadProgress(progress: ProgressInfo) {
		if (this.status.state !== 'downloading') {
			return;
		}

		const percent = Math.floor(progress.percent);
		if (percent === this.status.percent) {
			return;
		}

		this.setStatus({
			percent,
			bytesPerSecond: progress.bytesPerSecond,
			transferredBytes: progress.transferred,
			totalBytes: progress.total,
		});
	}

	private handleUpdateDownloaded(info: UpdateInfo) {
		this.consecutiveTransientFailures = 0;
		this.setStatus({
			state: 'downloaded',
			availableVersion: info.version,
			manualInstallRequired: undefined,
			percent: 100,
			bytesPerSecond: undefined,
			message: undefined,
		});
	}

	private handleUpdateNotAvailable(info: UpdateInfo) {
		this.consecutiveTransientFailures = 0;
		this.setStatus({
			state: 'not-available',
			availableVersion: info.version,
			manualInstallRequired: undefined,
			checkedAtIso: new Date().toISOString(),
			percent: undefined,
			bytesPerSecond: undefined,
			transferredBytes: undefined,
			totalBytes: undefined,
			message: undefined,
			releaseNotes: undefined,
		});
	}

	private handleUpdateError(error: Error) {
		console.error('[desktop] Auto-update error', error);
		const failedDownload = this.downloadingInfo;
		this.downloadingInfo = undefined;

		if (isTransientError(error)) {
			this.consecutiveTransientFailures += 1;

			if (this.consecutiveTransientFailures <= MAX_TRANSIENT_RETRIES) {
				const retryDelay = RETRY_BASE_DELAY_MS * this.consecutiveTransientFailures;
				console.log(
					`[desktop] Transient update error (attempt ${this.consecutiveTransientFailures}/${MAX_TRANSIENT_RETRIES}), retrying in ${retryDelay}ms`,
				);
				this.scheduleRetry(retryDelay);
				return;
			}

			console.warn(
				`[desktop] Transient update error persisted after ${MAX_TRANSIENT_RETRIES} retries, surfacing to user`,
			);
			this.consecutiveTransientFailures = 0;
		}

		if (failedDownload && UPDATE_VERIFICATION_ERROR_PATTERN.test(error.message ?? '')) {
			this.setStatus({
				state: 'error',
				availableVersion: failedDownload.version,
				manualInstallRequired: undefined,
				checkedAtIso: new Date().toISOString(),
				percent: undefined,
				bytesPerSecond: undefined,
				message: UNVERIFIED_UPDATE_MESSAGE,
				releaseNotes: undefined,
			});
			return;
		}

		// A download that fails for any other reason falls back to the manual
		// installer link.
		if (failedDownload) {
			this.setStatus({
				state: 'available',
				availableVersion: failedDownload.version,
				manualInstallRequired: true,
				checkedAtIso: new Date().toISOString(),
				percent: undefined,
				bytesPerSecond: undefined,
				message: resolveUserFacingUpdateErrorMessage(error),
			});
			return;
		}

		this.setStatus({
			state: 'error',
			manualInstallRequired: undefined,
			checkedAtIso: new Date().toISOString(),
			message: resolveUserFacingUpdateErrorMessage(error),
		});
	}

	private scheduleRetry(delayMs: number) {
		if (this.retryHandle) {
			clearTimeout(this.retryHandle);
		}

		this.retryHandle = setTimeout(() => {
			this.retryHandle = undefined;
			void this.checkForUpdates();
		}, delayMs);

		this.retryHandle.unref();
	}

	private markDisabled(reason: string) {
		this.enabled = false;
		this.setStatus({
			state: 'disabled',
			manualInstallRequired: undefined,
			message: reason,
		});
	}

	public start(listener: TStatusListener) {
		this.statusListener = listener;
		this.statusListener(this.status);

		if (this.initialized) {
			return;
		}

		this.initialized = true;

		if (!app.isPackaged) {
			this.markDisabled('Auto-update is disabled in development builds.');
			return;
		}

		if (process.platform === 'linux') {
			this.markDisabled('Auto-update is not supported on Linux. Download the latest version from the releases page.');
			return;
		}

		if (process.platform === 'darwin') {
			this.markDisabled(
				'Automatic updates are not yet available on macOS. Download the latest version from the releases page.',
			);
			return;
		}

		// Beta builds (0.0.0-beta.N) are not published to the stable update feed.
		if (app.getVersion().includes('-')) {
			this.markDisabled('Automatic updates are not available for beta builds.');
			return;
		}

		const appUpdateConfig = readAppUpdateConfig();
		if (appUpdateConfig === undefined) {
			this.markDisabled(
				'Auto-update metadata is missing (app-update.yml). Install the packaged desktop app to enable updates.',
			);
			return;
		}

		this.enabled = true;
		autoUpdater.autoDownload = false;
		autoUpdater.allowPrerelease = false;

		// electron-updater only runs the signature check when app-update.yml names
		// a publisher, so without one, updates stay manual instead of unverified.
		if (autoUpdater instanceof NsisUpdater && /^publisherName:/m.test(appUpdateConfig)) {
			const nsisUpdater = autoUpdater;
			nsisUpdater.verifyUpdateCodeSignature = async (_publisherNames, filePath) => {
				const info = this.downloadingInfo;
				if (!info) {
					return 'No update download is in progress.';
				}

				return await verifyDownloadedUpdate({ info, filePath });
			};
			nsisUpdater.autoInstallOnAppQuit = true;
			// Web-installer packages are not covered by the update signature.
			nsisUpdater.disableWebInstaller = true;
			this.nsisUpdater = nsisUpdater;
		} else {
			console.warn('[desktop] Update verification is unavailable; updates must be installed manually.');
			autoUpdater.autoInstallOnAppQuit = false;
		}

		autoUpdater.on('checking-for-update', () => {
			this.setStatus({
				state: 'checking',
				manualInstallRequired: undefined,
				message: undefined,
			});
		});

		autoUpdater.on('update-available', (info) => {
			this.handleUpdateAvailable(info);
		});

		autoUpdater.on('update-not-available', (info) => {
			this.handleUpdateNotAvailable(info);
		});

		autoUpdater.on('download-progress', (progress) => {
			this.handleDownloadProgress(progress);
		});

		autoUpdater.on('update-downloaded', (info) => {
			this.handleUpdateDownloaded(info);
		});

		autoUpdater.on('error', (error) => {
			this.handleUpdateError(error);
		});

		void this.checkForUpdates();

		this.intervalHandle = setInterval(() => {
			void this.checkForUpdates();
		}, UPDATE_CHECK_INTERVAL_MS);

		this.intervalHandle.unref();
	}

	public async checkForUpdates() {
		// A newer release found mid-download would replace the metadata the
		// signature check expects, and a downloaded update is installed on quit.
		if (!this.enabled || this.downloadInFlight || this.status.state === 'downloaded') {
			return;
		}

		try {
			await autoUpdater.checkForUpdates();
		} catch {
			// Check failures also arrive through the 'error' event; handling them
			// here as well would count each failure twice toward the retry limit.
		}
	}

	// Quits through the normal quit flow, which flushes the renderer and stops
	// the capture sidecar before installPendingUpdateBeforeQuit runs.
	public restartToUpdate(): boolean {
		if (this.status.state !== 'downloaded' || !this.nsisUpdater) {
			return false;
		}

		this.restartRequested = true;
		app.quit();
		return true;
	}

	// Called at the end of the quit flow. A plain quit installs silently through
	// electron-updater's quit handler (autoInstallOnAppQuit); only an explicit
	// restart relaunches the app after installing.
	public installPendingUpdateBeforeQuit() {
		if (!this.restartRequested || !this.nsisUpdater) {
			return;
		}

		this.restartRequested = false;
		this.nsisUpdater.install(true, true);
	}

	public getStatus() {
		return this.status;
	}

	public dispose() {
		if (this.intervalHandle) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = undefined;
		}
		if (this.retryHandle) {
			clearTimeout(this.retryHandle);
			this.retryHandle = undefined;
		}
	}
}

const desktopUpdater = new DesktopUpdater();

export { desktopUpdater };
