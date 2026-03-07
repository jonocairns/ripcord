import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const PREVIEW_RUNTIME_CONFIG_FILENAME = "sharkord-preview-runtime.json";
const DEFAULT_PREVIEW_USER_DATA_SUFFIX = "Preview";

type TPreviewRuntimeConfig = {
  appUserModelId?: string;
  userDataSuffix?: string;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const normalizeNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
};

const readPreviewRuntimeConfig = (): TPreviewRuntimeConfig | null => {
  if (!app.isPackaged) {
    return null;
  }

  const configPath = path.join(
    process.resourcesPath,
    PREVIEW_RUNTIME_CONFIG_FILENAME,
  );

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const rawConfig = fs.readFileSync(configPath, "utf8");
    const parsedConfig: unknown = JSON.parse(rawConfig);

    if (!isObjectRecord(parsedConfig)) {
      return null;
    }

    return {
      appUserModelId: normalizeNonEmptyString(parsedConfig.appUserModelId),
      userDataSuffix: normalizeNonEmptyString(parsedConfig.userDataSuffix),
    };
  } catch (error) {
    console.warn("[desktop] Failed to read preview runtime config", error);
    return null;
  }
};

const applyPreviewRuntimeConfig = (
  config: TPreviewRuntimeConfig,
): TPreviewRuntimeConfig => {
  const userDataSuffix =
    config.userDataSuffix || DEFAULT_PREVIEW_USER_DATA_SUFFIX;
  const baseAppName = app.getName().trim() || "Ripcord";
  const previewUserDataPath = path.join(
    app.getPath("appData"),
    `${baseAppName} ${userDataSuffix}`,
  );

  app.setPath("userData", previewUserDataPath);
  app.setPath("sessionData", path.join(previewUserDataPath, "sessionData"));

  return {
    appUserModelId: config.appUserModelId,
    userDataSuffix,
  };
};

const previewRuntimeConfig = (() => {
  const config = readPreviewRuntimeConfig();
  if (!config) {
    return null;
  }

  return applyPreviewRuntimeConfig(config);
})();

export { previewRuntimeConfig };
