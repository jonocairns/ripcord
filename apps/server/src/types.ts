import { z } from 'zod';

export const zTokenPayload = z.object({
	userId: z.number(),
	tokenVersion: z.number(),
	exp: z.number(),
});

export type TConnectionInfo = {
	ip?: string;
	os?: string;
	device?: string;
	userAgent?: string;
};
