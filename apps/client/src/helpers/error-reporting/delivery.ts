import { fitDiagnosticRecord, type TDiagnosticRecord } from '@sharkord/shared';
import { createDiagnosticCollector } from './collector';

let identity: string | undefined;
export const getDiagnosticIdentity = () => identity;
let collector: ReturnType<typeof createDiagnosticCollector> | undefined;
export const configureDiagnosticDelivery = (
	options: Parameters<typeof createDiagnosticCollector>[0],
	nextIdentity: string,
	supported: boolean,
) => {
	try {
		collector ??= createDiagnosticCollector(options);
		identity = supported ? nextIdentity : undefined;
		collector.configure(nextIdentity, supported, options.upload);
	} catch {
		/* Optional. */
	}
};
export const authenticateDiagnosticDelivery = () => collector?.authenticate();
export const pauseDiagnosticDelivery = () => collector?.pause();
export const clearDiagnosticDelivery = () => {
	identity = undefined;
	collector?.clear();
};
export const flushDiagnosticDelivery = async () => {
	try {
		await collector?.flush(1000);
	} catch {
		/* Best effort. */
	}
};
export const recordDiagnostic = (record: Omit<TDiagnosticRecord, 'sequence'>): void => {
	try {
		const fitted = fitDiagnosticRecord({ ...record, sequence: 0 });
		if (fitted) collector?.record(fitted);
	} catch {
		/* Never report reporting failures. */
	}
};
