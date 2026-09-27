class HttpValidationError extends Error {
	field: string;

	constructor(field: string, message: string) {
		super(message);
		this.name = 'HttpValidationError';
		this.field = field;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

class HttpPayloadTooLargeError extends Error {
	maxBytes: number;

	constructor(maxBytes: number) {
		super('Request body too large');
		this.name = 'HttpPayloadTooLargeError';
		this.maxBytes = maxBytes;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

class HttpRateLimitError extends Error {
	retryAfterMs: number;

	constructor(message: string, retryAfterMs: number) {
		super(message);
		this.name = 'HttpRateLimitError';
		this.retryAfterMs = retryAfterMs;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export { HttpPayloadTooLargeError, HttpRateLimitError, HttpValidationError };
