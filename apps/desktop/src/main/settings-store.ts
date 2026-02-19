import { app } from "electron";
import fs from "fs/promises";
import path from "path";

type TDesktopSettings = {
  serverUrl?: string;
};

const SETTINGS_FILENAME = "desktop-settings.json";

const getSettingsPath = () => {
  return path.join(app.getPath("userData"), SETTINGS_FILENAME);
};

const readSettings = async (): Promise<TDesktopSettings> => {
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf8");
    const parsed = JSON.parse(raw) as TDesktopSettings;

    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
};

const writeSettings = async (settings: TDesktopSettings) => {
  const settingsPath = getSettingsPath();

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
};

const getServerUrl = async () => {
  const settings = await readSettings();
  return settings.serverUrl?.trim() || "";
};

const setServerUrl = async (serverUrl: string) => {
  const normalizedUrl = serverUrl.trim();
  const settings = await readSettings();

  settings.serverUrl = normalizedUrl;

  await writeSettings(settings);
};

export { getServerUrl, setServerUrl };
