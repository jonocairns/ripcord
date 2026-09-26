const getLoginErrors = (value: unknown, retryAfter: string | null): Record<string, string> => {
	const data = typeof value === 'object' && value !== null ? value : {};
	const errors = 'errors' in data ? data.errors : undefined;
	if (typeof errors === 'object' && errors !== null) {
		const fields = Object.fromEntries(
			Object.entries(errors).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
		);
		if (Object.keys(fields).length > 0) return fields;
	}

	const error = 'error' in data && typeof data.error === 'string' ? data.error : 'Sign-in failed. Please try again.';
	const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
	const minutes = Math.ceil(seconds / 60);
	const wait =
		Number.isFinite(seconds) && seconds > 0 ? ` Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.` : '';
	return { identity: error + wait };
};

export { getLoginErrors };
