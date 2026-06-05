import type {
  TDesktopQuitFlushResult,
  TDesktopPushKeybindsInput,
  TScreenAudioMode,
  TScreenShareSelection,
  TStartAppAudioCaptureInput,
} from "./types";

const MAX_ID_LENGTH = 512;
const MAX_SERVER_URL_LENGTH = 2048;
const MAX_KEYBIND_LENGTH = 128;

const AUDIO_MODES: readonly TScreenAudioMode[] = ["system", "app", "none"];

const fail = (message: string): never => {
  throw new Error(`Invalid IPC payload: ${message}`);
};

const assertString = (
  value: unknown,
  field: string,
  maxLength: number,
): string => {
  if (typeof value !== "string") {
    return fail(`${field} must be a string`);
  }

  if (value.length > maxLength) {
    return fail(`${field} exceeds ${maxLength} characters`);
  }

  return value;
};

const assertNonEmptyString = (
  value: unknown,
  field: string,
  maxLength: number,
): string => {
  const stringValue = assertString(value, field, maxLength);

  if (stringValue.trim().length === 0) {
    return fail(`${field} must not be empty`);
  }

  return stringValue;
};

const assertOptionalString = (
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return assertString(value, field, maxLength);
};

const assertRecord = (
  value: unknown,
  field: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
};

const assertAudioMode = (value: unknown, field: string): TScreenAudioMode => {
  if (
    typeof value !== "string" ||
    !AUDIO_MODES.includes(value as TScreenAudioMode)
  ) {
    return fail(`${field} must be one of ${AUDIO_MODES.join(", ")}`);
  }

  return value as TScreenAudioMode;
};

const validateSetServerUrlArgs = (args: unknown[]): [string] => {
  const serverUrl = assertString(args[0], "serverUrl", MAX_SERVER_URL_LENGTH);
  const trimmed = serverUrl.trim();

  if (trimmed.length > 0) {
    let parsed: URL;

    try {
      parsed = new URL(trimmed);
    } catch {
      return fail("serverUrl must be a valid URL");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fail("serverUrl must use http or https");
    }

    return [trimmed];
  }

  return [serverUrl];
};

const validateListAppAudioTargetsArgs = (
  args: unknown[],
): [string | undefined] => {
  return [assertOptionalString(args[0], "sourceId", MAX_ID_LENGTH)];
};

const validateStopAppAudioCaptureArgs = (
  args: unknown[],
): [string | undefined] => {
  return [assertOptionalString(args[0], "sessionId", MAX_ID_LENGTH)];
};

const validateStartAppAudioCaptureArgs = (
  args: unknown[],
): [TStartAppAudioCaptureInput] => {
  const input = assertRecord(args[0], "input");

  // selfExcludePid is intentionally dropped here; the main process sets it.
  return [
    {
      sourceId: assertNonEmptyString(
        input.sourceId,
        "input.sourceId",
        MAX_ID_LENGTH,
      ),
      appAudioTargetId: assertOptionalString(
        input.appAudioTargetId,
        "input.appAudioTargetId",
        MAX_ID_LENGTH,
      ),
    },
  ];
};

const validatePrepareScreenShareArgs = (
  args: unknown[],
): [TScreenShareSelection] => {
  const selection = assertRecord(args[0], "selection");

  return [
    {
      sourceId: assertNonEmptyString(
        selection.sourceId,
        "selection.sourceId",
        MAX_ID_LENGTH,
      ),
      audioMode: assertAudioMode(selection.audioMode, "selection.audioMode"),
      appAudioTargetId: assertOptionalString(
        selection.appAudioTargetId,
        "selection.appAudioTargetId",
        MAX_ID_LENGTH,
      ),
    },
  ];
};

const validateSetGlobalPushKeybindsArgs = (
  args: unknown[],
): [TDesktopPushKeybindsInput | undefined] => {
  if (args[0] === undefined) {
    return [undefined];
  }

  const input = assertRecord(args[0], "input");

  return [
    {
      pushToTalkKeybind: assertOptionalString(
        input.pushToTalkKeybind,
        "input.pushToTalkKeybind",
        MAX_KEYBIND_LENGTH,
      ),
      pushToMuteKeybind: assertOptionalString(
        input.pushToMuteKeybind,
        "input.pushToMuteKeybind",
        MAX_KEYBIND_LENGTH,
      ),
    },
  ];
};

const validateDesktopQuitFlushResultArgs = (
  args: unknown[],
): [TDesktopQuitFlushResult] => {
  const result = assertRecord(args[0], "result");
  const status = assertString(result.status, "result.status", MAX_ID_LENGTH);

  if (status !== "succeeded" && status !== "skipped") {
    return fail("result.status must be succeeded or skipped");
  }

  return [
    {
      status,
      reason: assertOptionalString(
        result.reason,
        "result.reason",
        MAX_ID_LENGTH,
      ),
    },
  ];
};

export {
  validateDesktopQuitFlushResultArgs,
  validateListAppAudioTargetsArgs,
  validatePrepareScreenShareArgs,
  validateSetGlobalPushKeybindsArgs,
  validateSetServerUrlArgs,
  validateStartAppAudioCaptureArgs,
  validateStopAppAudioCaptureArgs,
};
