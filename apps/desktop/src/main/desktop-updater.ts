import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import type { TDesktopUpdateStatus } from './types';
import { resolveReleaseNotes } from './update-release-notes';
import { verifyDownloadedUpdate, verifyUpdateMetadata } from './update-verification';

// The update state machine, kept free of Electron so it can be tested with
// fakes. updater.ts wires it to electron-updater and the app lifecycle.

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_UPDATE_ERROR_MESSAGE_LENGTH = 280;
const MAX_TRANSIENT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 15_000;

// Errors meaning the downloaded file is not the signed one: our signature hook
// (ERR_UPDATER_INVALID_SIGNATURE) or electron-updater's own hash check, which
// runs first when the installer asset was replaced.
const UPDATE_VERIFICATION_ERROR_PATTERN =
	/ERR_UPDATER_INVALID_SIGNATURE|not signed by the application owner|ERR_CHECKSUM_MISMATCH|checksum mismatch/i;
const TRANSIENT_ERROR_PATTERN =
	/ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|network|502|503|504|429|Bad Gateway|Service Unavailable|Gateway Timeout/i;
const UNVERIFIED_UPDATE_MESSAGE = 'This update could not be verified, so it was not installed.';

type TStatusListener = (status: TDesktopUpdateStatus) => void;

type TTimerHandle = { cancel: () => void };

type TUpdateInstaller = {
	downloadUpdate: () => Promise<unknown>;
	install: (isSilent: boolean, isForceRunAfter: boolean) => boolean;
};

type TDesktopUpdaterDeps = {
	getVersion: () => string;
	quitApp: () => void;
	relaunchApp: () => void;
	checkForUpdates: () => Promise<unknown>;
	verifyMetadata?: (info: UpdateInfo) => string | null;
	verifyDownload?: (info: UpdateInfo, filePath: string) => Promise<string | null>;
	setTimer?: (callback: () => void, delayMs: number, repeat: boolean) => TTimerHandle;
	log?: Pick<Console, 'log' | 'warn' | 'error'>;
};

const describeError = (error: Error): string => {
	const code: unknown = Reflect.get(error, 'code');
	return `${typeof code === 'string' ? code : ''} ${error.message ?? ''}`;
};

const isVerificationError = (error: Error): boolean => UPDATE_VERIFICATION_ERROR_PATTERN.test(describeError(error));

const isTransientError = (error: Error): boolean =>
	!isVerificationError(error) && TRANSIENT_ERROR_PATTERN.test(error.message ?? '');

const resolveUserFacingUpdateErrorMessage = (error: Error): string => {
	if (isVerificationError(error)) {
		return UNVERIFIED_UPDATE_MESSAGE;
	}

	const normalized = (error.message?.trim() || 'Unknown updater error.').replace(/\s+/g, ' ');
	const compact = normalized.replace(/\s*raw info:\s*.+$/i, '') || normalized;
	if (compact.length <= MAX_UPDATE_ERROR_MESSAGE_LENGTH) {
		return compact;
	}

	return `${compact.slice(0, MAX_UPDATE_ERROR_MESSAGE_LENGTH - 1)}…`;
};

const defaultSetTimer = (callback: () => void, delayMs: number, repeat: boolean): TTimerHandle => {
	const handle = repeat ? setInterval(callback, delayMs) : setTimeout(callback, delayMs);
	handle.unref();
	return { cancel: () => (repeat ? clearInterval(handle) : clearTimeout(handle)) };
};

class DesktopUpdater {
	private status: TDesktopUpdateStatus;
	private enabled = false;
	private statusListener?: TStatusListener;
	private intervalHandle?: TTimerHandle;
	private retryHandle?: TTimerHandle;
	private consecutiveTransientFailures = 0;
	private installer?: TUpdateInstaller;
	// The update being downloaded. The signature check reads it because
	// electron-updater only passes the downloaded file's path.
	private downloadingInfo?: UpdateInfo;
	private downloadInFlight = false;
	private restartRequested = false;
	private readonly verifyMetadata: (info: UpdateInfo) => string | null;
	private readonly verifyDownload: (info: UpdateInfo, filePath: string) => Promise<string | null>;
	private readonly setTimer: (callback: () => void, delayMs: number, repeat: boolean) => TTimerHandle;
	private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;

	constructor(private readonly deps: TDesktopUpdaterDeps) {
		this.status = { state: 'idle', currentVersion: deps.getVersion() };
		this.verifyMetadata = deps.verifyMetadata ?? ((info) => verifyUpdateMetadata(info));
		this.verifyDownload = deps.verifyDownload ?? ((info, filePath) => verifyDownloadedUpdate({ info, filePath }));
		this.setTimer = deps.setTimer ?? defaultSetTimer;
		this.log = deps.log ?? console;
	}

	// `unverified` only survives when the update explicitly sets it, so any other
	// transition clears it.
	private setStatus(next: Partial<TDesktopUpdateStatus>) {
		this.status = {
			...this.status,
			...next,
			unverified: next.unverified,
			currentVersion: this.deps.getVersion(),
		};
		this.statusListener?.(this.status);
	}

	private setUnverified(version: string) {
		this.setStatus({
			state: 'error',
			availableVersion: version,
			manualInstallRequired: undefined,
			unverified: true,
			checkedAtIso: new Date().toISOString(),
			percent: undefined,
			bytesPerSecond: undefined,
			message: UNVERIFIED_UPDATE_MESSAGE,
			releaseNotes: undefined,
		});
	}

	private scheduleRetry(delayMs: number) {
		this.retryHandle?.cancel();
		this.retryHandle = this.setTimer(
			() => {
				this.retryHandle = undefined;
				void this.checkForUpdates();
			},
			delayMs,
			false,
		);
	}

	public subscribe(listener: TStatusListener) {
		this.statusListener = listener;
		listener(this.status);
	}

	public markDisabled(reason: string) {
		this.enabled = false;
		this.setStatus({ state: 'disabled', manualInstallRequired: undefined, message: reason });
	}

	// Without an installer (no verifiable app-update.yml), updates stay manual.
	public enable(installer: TUpdateInstaller | undefined) {
		this.enabled = true;
		this.installer = installer;
		void this.checkForUpdates();
		this.intervalHandle = this.setTimer(() => void this.checkForUpdates(), UPDATE_CHECK_INTERVAL_MS, true);
	}

	public handleCheckingForUpdate() {
		this.setStatus({ state: 'checking', manualInstallRequired: undefined, message: undefined });
	}

	public handleUpdateAvailable(info: UpdateInfo) {
		if (!this.installer) {
			this.consecutiveTransientFailures = 0;
			this.setStatus({
				state: 'available',
				availableVersion: info.version,
				manualInstallRequired: true,
				checkedAtIso: new Date().toISOString(),
				message: undefined,
				releaseNotes: resolveReleaseNotes({
					info,
					currentVersion: this.deps.getVersion(),
					availableVersion: info.version,
				}),
			});
			return;
		}

		// Every release after this build is signed, so a missing or invalid
		// signature means the release assets were altered. Offer no download link:
		// it would point at the same unverified installer.
		const rejection = this.verifyMetadata(info);
		if (rejection) {
			this.log.error('[desktop] Rejected unverified update', { version: info.version, reason: rejection });
			this.setUnverified(info.version);
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
			releaseNotes: resolveReleaseNotes({
				info,
				currentVersion: this.deps.getVersion(),
				availableVersion: info.version,
			}),
		});

		void this.installer
			.downloadUpdate()
			.catch(() => {
				// Download failures also arrive through the 'error' event.
			})
			.finally(() => {
				this.downloadInFlight = false;
			});
	}

	public handleDownloadProgress(progress: ProgressInfo) {
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

	public handleUpdateDownloaded(info: UpdateInfo) {
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

	public handleUpdateNotAvailable(info: UpdateInfo) {
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

	public handleUpdateError(error: Error) {
		this.log.error('[desktop] Auto-update error', error);

		// electron-updater emits update-downloaded and queues the install before
		// its last cache housekeeping, which can still fail. The verified update
		// stays ready, so keep showing it.
		if (this.status.state === 'downloaded') {
			return;
		}

		const failedDownload = this.downloadingInfo;
		this.downloadingInfo = undefined;

		if (failedDownload && isVerificationError(error)) {
			this.setUnverified(failedDownload.version);
			return;
		}

		if (isTransientError(error)) {
			this.consecutiveTransientFailures += 1;

			if (this.consecutiveTransientFailures <= MAX_TRANSIENT_RETRIES) {
				const retryDelay = RETRY_BASE_DELAY_MS * this.consecutiveTransientFailures;
				this.log.log(
					`[desktop] Transient update error (attempt ${this.consecutiveTransientFailures}/${MAX_TRANSIENT_RETRIES}), retrying in ${retryDelay}ms`,
				);
				this.scheduleRetry(retryDelay);
				return;
			}

			this.log.warn(`[desktop] Transient update error persisted after ${MAX_TRANSIENT_RETRIES} retries`);
			this.consecutiveTransientFailures = 0;
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

	// electron-updater's signature hook. Returns null to accept the download.
	public async verifyDownloadedFile(filePath: string): Promise<string | null> {
		const info = this.downloadingInfo;
		if (!info) {
			return 'No update download is in progress.';
		}

		return await this.verifyDownload(info, filePath);
	}

	public async checkForUpdates() {
		// A newer release found mid-download would replace the metadata the
		// signature check expects, and a downloaded update is installed on quit.
		if (!this.enabled || this.downloadInFlight || this.status.state === 'downloaded') {
			return;
		}

		try {
			await this.deps.checkForUpdates();
		} catch {
			// Check failures also arrive through the 'error' event; handling them
			// here as well would count each failure twice toward the retry limit.
		}
	}

	// Quits through the normal quit flow, which flushes the renderer and stops
	// the capture sidecar before installPendingUpdateBeforeQuit runs.
	public restartToUpdate(): boolean {
		if (this.status.state !== 'downloaded' || !this.installer) {
			return false;
		}

		this.restartRequested = true;
		this.deps.quitApp();
		return true;
	}

	// Called at the end of the quit flow. A plain quit installs silently through
	// electron-updater's quit handler (autoInstallOnAppQuit); only an explicit
	// restart relaunches the app after installing.
	public installPendingUpdateBeforeQuit() {
		if (!this.restartRequested || !this.installer) {
			return;
		}

		this.restartRequested = false;
		// The app is already shutting down, so a failed start cannot be undone.
		// Relaunch the current version instead of leaving Ripcord closed: the
		// cached installer shows as ready again on the next launch.
		if (!this.installer.install(true, true)) {
			this.log.error('[desktop] Update installer did not start; relaunching the current version');
			this.deps.relaunchApp();
		}
	}

	public getStatus() {
		return this.status;
	}

	public dispose() {
		this.intervalHandle?.cancel();
		this.intervalHandle = undefined;
		this.retryHandle?.cancel();
		this.retryHandle = undefined;
	}
}

export { DesktopUpdater };
