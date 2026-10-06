import type { Page } from '@playwright/test';

type TrpcCall = {
	path: string[];
	method: 'mutate' | 'query';
	input?: unknown;
};

// Calls a procedure through the app's own tRPC client inside the page, so the
// request carries that page's signed-in session. Use it for setup a real user
// could perform through the UI; shipped code exposes no E2E-only routes.
const callTrpc = async (page: Page, call: TrpcCall): Promise<unknown> => {
	return page.evaluate(async ({ path, method, input }) => {
		const procedureName = [...path, method].join('.');
		const member = (value: unknown, key: string): unknown => {
			if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
				throw new Error(`tRPC ${procedureName} is unavailable at "${key}"`);
			}

			return Reflect.get(value, key);
		};

		const modulePath = '/src/lib/trpc.ts';
		const trpcModule: unknown = await import(modulePath);
		const getClient = member(trpcModule, 'getTRPCClient');
		if (typeof getClient !== 'function') {
			throw new Error('The tRPC client module does not export getTRPCClient');
		}

		let procedure: unknown = Reflect.apply(getClient, undefined, []);
		for (const segment of path) {
			procedure = member(procedure, segment);
		}

		const invoke = member(procedure, method);
		if (typeof invoke !== 'function') {
			throw new Error(`tRPC ${procedureName} is not callable`);
		}

		return Reflect.apply(invoke, procedure, input === undefined ? [] : [input]);
	}, call);
};

export { callTrpc };
