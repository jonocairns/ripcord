import type {
	TAppAudioRtpTarget,
	TDesktopErrorReportingConfig,
	TDesktopPushKeybindsInput,
	TDesktopQuitFlushResult,
	TScreenAudioMode,
	TScreenShareSelection,
	TStartAppAudioCaptureInput,
} from './types';

const MAX_ID_LENGTH = 512;
const MAX_SERVER_URL_LENGTH = 2048;
const MAX_KEYBIND_LENGTH = 128;
const MAX_DSN_LENGTH = 2048;
const MAX_IGNORE_ERRORS = 200;
const MAX_IGNORE_ERROR_LENGTH = 512;

const AUDIO_MODES: readonly TScreenAudioMode[] = ['system', 'app', 'none'];

const fail = (message: string): never => {
	throw new Error(`Invalid IPC payload: ${message}`);
};

const assertString = (value: unknown, field: string, maxLength: number): string => {
	if (typeof value !== 'string') {
		return fail(`${field} must be a string`);
	}

	if (value.length > maxLength) {
		return fail(`${field} exceeds ${maxLength} characters`);
	}

	return value;
};

const assertNonEmptyString = (value: unknown, field: string, maxLength: number): string => {
	const stringValue = assertString(value, field, maxLength);

	if (stringValue.trim().length === 0) {
		return fail(`${field} must not be empty`);
	}

	return stringValue;
};

const assertOptionalString = (value: unknown, field: string, maxLength: number): string | undefined => {
	if (value === undefined) {
		return undefined;
	}

	return assertString(value, field, maxLength);
};

const assertRecord = (value: unknown, field: string): Record<string, unknown> => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return fail(`${field} must be an object`);
	}

	return value as Record<string, unknown>;
};

const assertAudioMode = (value: unknown, field: string): TScreenAudioMode => {
	if (typeof value !== 'string' || !AUDIO_MODES.includes(value as TScreenAudioMode)) {
		return fail(`${field} must be one of ${AUDIO_MODES.join(', ')}`);
	}

	return value as TScreenAudioMode;
};

const assertOptionalBoolean = (value: unknown, field: string): boolean | undefined => {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'boolean') {
		return fail(`${field} must be a boolean`);
	}

	return value;
};

const validateSetServerUrlArgs = (args: unknown[]): [string] => {
	const serverUrl = assertString(args[0], 'serverUrl', MAX_SERVER_URL_LENGTH);
	const trimmed = serverUrl.trim();

	if (trimmed.length > 0) {
		let parsed: URL;

		try {
			parsed = new URL(trimmed);
		} catch {
			return fail('serverUrl must be a valid URL');
		}

		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return fail('serverUrl must use http or https');
		}

		return [trimmed];
	}

	return [serverUrl];
};

const validateListAppAudioTargetsArgs = (args: unknown[]): [string | undefined] => {
	return [assertOptionalString(args[0], 'sourceId', MAX_ID_LENGTH)];
};

const validateStopAppAudioCaptureArgs = (args: unknown[]): [string | undefined] => {
	return [assertOptionalString(args[0], 'sessionId', MAX_ID_LENGTH)];
};

const validateStartAppAudioCaptureArgs = (args: unknown[]): [TStartAppAudioCaptureInput] => {
	const input = assertRecord(args[0], 'input');

	// selfExcludePid is intentionally dropped here; the main process sets it.
	return [
		{
			sourceId: assertNonEmptyString(input.sourceId, 'input.sourceId', MAX_ID_LENGTH),
			appAudioTargetId: assertOptionalString(input.appAudioTargetId, 'input.appAudioTargetId', MAX_ID_LENGTH),
		},
	];
};

const assertPort = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 65_535) {
		return fail(`${field} must be an integer between 1 and 65535`);
	}

	return value;
};

const assertUint32 = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
		return fail(`${field} must be a 32-bit unsigned integer`);
	}

	return value;
};

const assertRtpPayloadType = (value: unknown, field: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 127) {
		return fail(`${field} must be an integer between 0 and 127`);
	}

	return value;
};

const validateStartAppAudioRtpArgs = (args: unknown[]): [TAppAudioRtpTarget] => {
	const target = assertRecord(args[0], 'target');

	const validated: TAppAudioRtpTarget = {
		ip: assertNonEmptyString(target.ip, 'target.ip', MAX_ID_LENGTH),
		port: assertPort(target.port, 'target.port'),
		ssrc: assertUint32(target.ssrc, 'target.ssrc'),
	};

	if (target.payloadType !== undefined) {
		validated.payloadType = assertRtpPayloadType(target.payloadType, 'target.payloadType');
	}

	return [validated];
};

const validatePrepareScreenShareArgs = (args: unknown[]): [TScreenShareSelection] => {
	const selection = assertRecord(args[0], 'selection');
	const useSystemPicker = assertOptionalBoolean(selection.useSystemPicker, 'selection.useSystemPicker');
	const validatedSelection: TScreenShareSelection = {
		sourceId: assertNonEmptyString(selection.sourceId, 'selection.sourceId', MAX_ID_LENGTH),
		audioMode: assertAudioMode(selection.audioMode, 'selection.audioMode'),
		appAudioTargetId: assertOptionalString(selection.appAudioTargetId, 'selection.appAudioTargetId', MAX_ID_LENGTH),
	};

	if (useSystemPicker !== undefined) {
		validatedSelection.useSystemPicker = useSystemPicker;
	}

	return [validatedSelection];
};

const validateSetGlobalPushKeybindsArgs = (args: unknown[]): [TDesktopPushKeybindsInput | undefined] => {
	if (args[0] === undefined) {
		return [undefined];
	}

	const input = assertRecord(args[0], 'input');

	return [
		{
			pushToTalkKeybind: assertOptionalString(input.pushToTalkKeybind, 'input.pushToTalkKeybind', MAX_KEYBIND_LENGTH),
			pushToMuteKeybind: assertOptionalString(input.pushToMuteKeybind, 'input.pushToMuteKeybind', MAX_KEYBIND_LENGTH),
		},
	];
};

const validateConfigureErrorReportingArgs = (args: unknown[]): [TDesktopErrorReportingConfig] => {
	const config = assertRecord(args[0], 'config');
	const validated: TDesktopErrorReportingConfig = {
		dsn: assertOptionalString(config.dsn, 'config.dsn', MAX_DSN_LENGTH),
	};

	if (config.ignoreErrors !== undefined) {
		if (!Array.isArray(config.ignoreErrors)) {
			return fail('config.ignoreErrors must be an array');
		}

		validated.ignoreErrors = config.ignoreErrors
			.slice(0, MAX_IGNORE_ERRORS)
			.map((entry, index) => assertString(entry, `config.ignoreErrors[${index}]`, MAX_IGNORE_ERROR_LENGTH));
	}

	if (config.tracingSampleRate !== undefined) {
		if (typeof config.tracingSampleRate !== 'number' || Number.isNaN(config.tracingSampleRate)) {
			return fail('config.tracingSampleRate must be a number');
		}

		validated.tracingSampleRate = config.tracingSampleRate;
	}

	return [validated];
};

const validateDesktopQuitFlushResultArgs = (args: unknown[]): [TDesktopQuitFlushResult] => {
	const result = assertRecord(args[0], 'result');
	const status = assertString(result.status, 'result.status', MAX_ID_LENGTH);

	if (status !== 'succeeded' && status !== 'skipped') {
		return fail('result.status must be succeeded or skipped');
	}

	return [
		{
			status,
			reason: assertOptionalString(result.reason, 'result.reason', MAX_ID_LENGTH),
		},
	];
};

export {
	validateConfigureErrorReportingArgs,
	validateDesktopQuitFlushResultArgs,
	validateListAppAudioTargetsArgs,
	validatePrepareScreenShareArgs,
	validateSetGlobalPushKeybindsArgs,
	validateSetServerUrlArgs,
	validateStartAppAudioCaptureArgs,
	validateStartAppAudioRtpArgs,
	validateStopAppAudioCaptureArgs,
};
