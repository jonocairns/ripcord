import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from "electron-updater";
import type { TDesktopUpdateStatus } from "./types";

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const APP_UPDATE_CONFIG_FILENAME = "app-update.yml";

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

class DesktopUpdater {
  private status: TDesktopUpdateStatus = createBaseStatus();
  private initialized = false;
  private enabled = false;
  private statusListener?: TStatusListener;
  private intervalHandle?: NodeJS.Timeout;

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
    this.setStatus({
      state: "available",
      availableVersion: info.version,
      checkedAtIso: new Date().toISOString(),
      message: undefined,
    });
  }

  private handleUpdateNotAvailable(info: UpdateInfo) {
    this.setStatus({
      state: "not-available",
      availableVersion: info.version,
      checkedAtIso: new Date().toISOString(),
      percent: undefined,
      bytesPerSecond: undefined,
      transferredBytes: undefined,
      totalBytes: undefined,
      message: undefined,
    });
  }

  private handleDownloadProgress(progress: ProgressInfo) {
    this.setStatus({
      state: "downloading",
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
      message: undefined,
    });
  }

  private handleUpdateDownloaded(info: UpdateInfo) {
    this.setStatus({
      state: "downloaded",
      availableVersion: info.version,
      checkedAtIso: new Date().toISOString(),
      percent: 100,
      message: "Update downloaded. Restart the app to install it.",
    });
  }

  private handleUpdateError(error: Error) {
    this.setStatus({
      state: "error",
      checkedAtIso: new Date().toISOString(),
      message: error.message,
    });
  }

  private markDisabled(reason: string) {
    this.enabled = false;
    this.setStatus({
      state: "disabled",
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
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
      this.setStatus({
        state: "checking",
        message: undefined,
      });
    });

    autoUpdater.on("update-available", (info) => {
      this.handleUpdateAvailable(info);
    });

    autoUpdater.on("update-not-available", (info) => {
      this.handleUpdateNotAvailable(info);
    });

    autoUpdater.on("download-progress", (progress) => {
      this.handleDownloadProgress(progress);
    });

    autoUpdater.on("update-downloaded", (info) => {
      this.handleUpdateDownloaded(info);
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
  }
}

const desktopUpdater = new DesktopUpdater();

export { desktopUpdater };
