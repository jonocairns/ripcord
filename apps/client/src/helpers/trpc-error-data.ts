const getRecordValue = (value: unknown, key: string): unknown | undefined => {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	return Reflect.get(value, key);
};

const getTrpcErrorData = (error: unknown): { code?: string; httpStatus?: number } | undefined => {
	const data = getRecordValue(error, 'data');

	if (typeof data !== 'object' || data === null) {
		return undefined;
	}

	const code = getRecordValue(data, 'code');
	const httpStatus = getRecordValue(data, 'httpStatus');

	return {
		code: typeof code === 'string' ? code : undefined,
		httpStatus: typeof httpStatus === 'number' ? httpStatus : undefined,
	};
};

const isNonRetriableTrpcError = (error: unknown): boolean => {
	const data = getTrpcErrorData(error);

	if (!data) {
		return false;
	}

	if (typeof data.httpStatus === 'number' && data.httpStatus >= 400 && data.httpStatus < 500) {
		return true;
	}

	return (
		data.code === 'BAD_REQUEST' ||
		data.code === 'UNAUTHORIZED' ||
		data.code === 'FORBIDDEN' ||
		data.code === 'NOT_FOUND'
	);
};

export { getTrpcErrorData, isNonRetriableTrpcError };
