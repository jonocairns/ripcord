import { TRPCClientError } from '@trpc/client';

export type TTrpcErrors = Record<string, string | undefined>;

const FALLBACK_ERROR_MESSAGE = 'Something went wrong, please try again.';

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const coerceFieldErrors = (value: unknown): TTrpcErrors | undefined => {
	if (!isRecord(value)) {
		return undefined;
	}

	const errors: TTrpcErrors = {};

	for (const [key, fieldError] of Object.entries(value)) {
		if (typeof fieldError === 'string' || fieldError === undefined) {
			errors[key] = fieldError;
		}
	}

	return Object.keys(errors).length > 0 ? errors : undefined;
};

const parseZodIssueErrors = (value: unknown): TTrpcErrors | undefined => {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const errors: TTrpcErrors = {};

	for (const issue of value) {
		if (!isRecord(issue)) {
			continue;
		}

		const message = issue.message;
		if (typeof message !== 'string') {
			continue;
		}

		const path = issue.path;
		const field = Array.isArray(path) && typeof path[0] === 'string' ? path[0] : '_general';

		errors[field] = message;
	}

	return Object.keys(errors).length > 0 ? errors : undefined;
};

const parseTrpcErrors = (err: unknown): TTrpcErrors => {
	if (!(err instanceof TRPCClientError)) {
		return (
			coerceFieldErrors(err) ?? {
				_general: err instanceof Error ? err.message : FALLBACK_ERROR_MESSAGE,
			}
		);
	}

	try {
		return parseZodIssueErrors(JSON.parse(err.message)) ?? { _general: err.message };
	} catch {
		return { _general: err.message };
	}
};

const getTrpcError = (err: unknown, fallback: string): string => {
	if (err instanceof TRPCClientError) {
		return err.message;
	}

	if (err instanceof Error) {
		return err.message;
	}

	return fallback;
};

export { getTrpcError, parseTrpcErrors };
