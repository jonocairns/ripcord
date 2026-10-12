import { diagnosticRecordSchema } from '@sharkord/shared';
import { memo, useEffect } from 'react';
import { flushVoiceForDesktopQuit } from '@/features/server/voice/actions';
import { flushDiagnosticDelivery } from '@/helpers/error-reporting';
import { getDiagnosticIdentity, recordDiagnostic } from '@/helpers/error-reporting/delivery';
import { getDesktopBridge } from '@/runtime/desktop-bridge';

const DesktopQuitCoordinator = memo(() => {
	useEffect(() => {
		const desktopBridge = getDesktopBridge();

		if (!desktopBridge) {
			return;
		}

		const unsubscribeDiagnostics = desktopBridge.subscribeDiagnosticRecord?.((payload) => {
			try {
				if (
					!payload ||
					typeof payload !== 'object' ||
					!('identity' in payload) ||
					!('record' in payload) ||
					payload.identity !== getDiagnosticIdentity()
				)
					return;
				const parsed = diagnosticRecordSchema.safeParse(payload.record);
				if (parsed.success) recordDiagnostic(parsed.data);
			} catch {
				/* Optional IPC. */
			}
		});
		let flushPromise: Promise<void> | undefined;

		const unsubscribeQuit = desktopBridge.subscribeBeforeQuit(() => {
			if (!flushPromise) {
				flushPromise = flushVoiceForDesktopQuit()
					.then(() => flushDiagnosticDelivery())
					.finally(() => {
						flushPromise = undefined;
					});
			}

			return flushPromise;
		});
		return () => {
			unsubscribeQuit();
			unsubscribeDiagnostics?.();
		};
	}, []);

	return null;
});

export { DesktopQuitCoordinator };
