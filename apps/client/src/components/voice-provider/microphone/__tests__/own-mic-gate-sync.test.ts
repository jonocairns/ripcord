import { expect, it, mock } from 'bun:test';
import { mountOwnMicGateSync } from '../own-mic-gate-sync';

it('applies synchronously on gate changes only and stops on unsubscribe', () => {
	let transmitting = true;
	let listener = () => {};
	const apply = mock((_muted: boolean) => {});
	const unsubscribe = mountOwnMicGateSync({
		isTransmitting: () => transmitting,
		subscribe: (fn) => {
			listener = fn;
			return () => {
				listener = () => {};
			};
		},
		apply,
	});
	listener();
	expect(apply).not.toHaveBeenCalled();
	transmitting = false;
	listener();
	listener();
	expect(apply.mock.calls).toEqual([[true]]);
	unsubscribe();
	transmitting = true;
	listener();
	expect(apply).toHaveBeenCalledTimes(1);
});
