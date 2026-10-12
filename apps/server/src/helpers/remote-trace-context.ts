import { context, propagation } from '@sharkord/shared/telemetry/propagation';

// Provider/context failure must neither skip nor repeat an application operation.
export const withRemoteTraceContext = <T>(
	carrier: Record<string, string> | undefined,
	effect: () => Promise<T>,
): Promise<T> => {
	let result: Promise<T> | undefined;
	const once = () => (result ??= effect());
	try {
		const parent = carrier ? propagation.extract(context.active(), carrier) : context.active();
		return context.with(parent, once);
	} catch {
		return once();
	}
};
