import { expect, spyOn, test } from 'bun:test';
import { context, propagation } from '@sharkord/shared/telemetry/propagation';
import { withRemoteTraceContext } from '../remote-trace-context';

test('context failures before and after dispatch cannot skip or repeat application operations', async () => {
	for (const failure of ['extract', 'before', 'after']) {
		let calls = 0;
		const extract = spyOn(propagation, 'extract');
		const withContext = spyOn(context, 'with');
		if (failure === 'extract')
			extract.mockImplementation(() => {
				throw Error('provider');
			});
		if (failure === 'before')
			withContext.mockImplementation(() => {
				throw Error('provider');
			});
		if (failure === 'after')
			withContext.mockImplementation((_ctx, fn, thisArg, ...args) => {
				Reflect.apply(fn, thisArg, args);
				throw Error('provider');
			});
		try {
			expect(
				await withRemoteTraceContext({ traceparent: 'carrier' }, async () => {
					calls++;
					return 'value';
				}),
			).toBe('value');
			expect(calls).toBe(1);
		} finally {
			extract.mockRestore();
			withContext.mockRestore();
		}
	}
});
