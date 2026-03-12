import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import type { TDesktopUpdateStatus } from "./types";

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const APP_UPDATE_CONFIG_FILENAME = "app-update.yml";
const MAX_UPDATE_ERROR_MESSAGE_LENGTH = 280;
const MANUAL_INSTALL_REQUIRED_ERROR_PATTERN =
  /ERR_UPDATER_INVALID_SIGNATURE|not signed by the application owner|sign verification failed/i;

const TRANSIENT_ERROR_PATTERN =
  /ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|network|502|503|504|429|Bad Gateway|Service Unavailable|Gateway Timeout/i;

const MAX_TRANSIENT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 15_000;

type TStatusListener = (status: TDesktopUpdateStatus) => void;

const createBaseStatus = (): TDesktopUpdateStatus => ({
  state: "idle",
  currentVersion: app.getVersion(),
});

const hasAppUpdateConfig = (): boolean => {
  const appUpdateConfigPath = path.join(
    process.resourcesPath,
    APP_UPDATE_CONFIG_FILENAME,
  );

  return fs.existsSync(appUpdateConfigPath);
};

const resolveUserFacingUpdateErrorMessage = (error: Error): string => {
  const rawMessage = error.message?.trim() || "Unknown updater error.";
  const normalized = rawMessage.replace(/\s+/g, " ").trim();

  if (MANUAL_INSTALL_REQUIRED_ERROR_PATTERN.test(normalized)) {
    return (
      "Update package signature could not be verified on this machine. " +
      "Please download and install the latest Ripcord version manually."
    );
  }

  const withoutRawInfo = normalized.replace(/\s*raw info:\s*.+$/i, "");
  const compact = withoutRawInfo || normalized;
  if (compact.length <= MAX_UPDATE_ERROR_MESSAGE_LENGTH) {
    return compact;
  }

  return `${compact.slice(0, MAX_UPDATE_ERROR_MESSAGE_LENGTH - 1)}…`;
};

const isManualInstallRequiredError = (error: Error): boolean => {
  const rawMessage = error.message?.trim() || "";
  const normalized = rawMessage.replace(/\s+/g, " ").trim();
  return MANUAL_INSTALL_REQUIRED_ERROR_PATTERN.test(normalized);
};

const isTransientError = (error: Error): boolean => {
  const rawMessage = error.message?.trim() || "";
  if (MANUAL_INSTALL_REQUIRED_ERROR_PATTERN.test(rawMessage)) {
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
    this.consecutiveTransientFailures = 0;
    this.setStatus({
      state: "available",
      availableVersion: info.version,
      manualInstallRequired: true,
      checkedAtIso: new Date().toISOString(),
      message: undefined,
    });
  }

  private handleUpdateNotAvailable(info: UpdateInfo) {
    this.consecutiveTransientFailures = 0;
    this.setStatus({
      state: "not-available",
      availableVersion: info.version,
      manualInstallRequired: undefined,
      checkedAtIso: new Date().toISOString(),
      percent: undefined,
      bytesPerSecond: undefined,
      transferredBytes: undefined,
      totalBytes: undefined,
      message: undefined,
    });
  }

  private handleUpdateError(error: Error) {
    console.error("[desktop] Auto-update error", error);

    if (isTransientError(error)) {
      this.consecutiveTransientFailures += 1;

      if (this.consecutiveTransientFailures <= MAX_TRANSIENT_RETRIES) {
        const retryDelay =
          RETRY_BASE_DELAY_MS * this.consecutiveTransientFailures;
        console.log(
          `[desktop] Transient update error (attempt ${this.consecutiveTransientFailures}/${MAX_TRANSIENT_RETRIES}), retrying in ${retryDelay}ms`,
        );
        this.scheduleRetry(retryDelay);
        return;
      }

      console.warn(
        `[desktop] Transient update error persisted after ${MAX_TRANSIENT_RETRIES} retries, surfacing to user`,
      );
    }

    const manualInstallRequired = isManualInstallRequiredError(error);

    this.setStatus({
      state: "error",
      manualInstallRequired,
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
      state: "disabled",
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
      this.markDisabled("Auto-update is disabled in development builds.");
      return;
    }

    if (process.platform !== "win32") {
      this.markDisabled("Auto-update is currently enabled for Windows only.");
      return;
    }

    if (!hasAppUpdateConfig()) {
      this.markDisabled(
        "Auto-update metadata is missing (app-update.yml). Install the packaged desktop app to enable updates.",
      );
      return;
    }

    this.enabled = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on("checking-for-update", () => {
      this.setStatus({
        state: "checking",
        manualInstallRequired: undefined,
        message: undefined,
      });
    });

    autoUpdater.on("update-available", (info) => {
      this.handleUpdateAvailable(info);
    });

    autoUpdater.on("update-not-available", (info) => {
      this.handleUpdateNotAvailable(info);
    });

    autoUpdater.on("error", (error) => {
      this.handleUpdateError(error);
    });

    void this.checkForUpdates();

    this.intervalHandle = setInterval(() => {
      void this.checkForUpdates();
    }, UPDATE_CHECK_INTERVAL_MS);

    this.intervalHandle.unref();
  }

  public async checkForUpdates() {
    if (!this.enabled) {
      return;
    }

    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.handleUpdateError(error as Error);
    }
  }

  public getStatus() {
    return this.status;
  }

  public installUpdateAndRestart() {
    if (!this.enabled || this.status.state !== "downloaded") {
      return false;
    }

    try {
      autoUpdater.quitAndInstall();
      return true;
    } catch (error) {
      this.handleUpdateError(error as Error);
      return false;
    }
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
