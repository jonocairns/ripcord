class HttpValidationError extends Error {
  field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'HttpValidationError';
    this.field = field;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class HttpBodyTooLargeError extends Error {
  maxBytes: number;

  constructor(maxBytes: number) {
    super(`Request body too large. Maximum allowed size is ${maxBytes} bytes.`);
    this.name = 'HttpBodyTooLargeError';
    this.maxBytes = maxBytes;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export { HttpBodyTooLargeError, HttpValidationError };
