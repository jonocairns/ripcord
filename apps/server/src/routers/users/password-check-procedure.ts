import { protectedProcedure, rateLimitedProcedure } from '../../utils/trpc';

// Every procedure that verifies the caller's current password shares one
// budget, so a stolen session cannot multiply its guesses across routes.
const passwordCheckProcedure = rateLimitedProcedure(protectedProcedure, {
	maxRequests: 10,
	windowMs: 60_000,
	keyBy: 'user',
	logLabel: 'passwordCheck',
});

export { passwordCheckProcedure };
