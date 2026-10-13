import { transports } from 'winston';

export const createRotatingFileTransport = (
	filename: string,
	level: string,
	policy: { maxSizeBytes: number; maxFiles: number },
) => new transports.File({ filename, level, maxsize: policy.maxSizeBytes, maxFiles: policy.maxFiles, tailable: true });
