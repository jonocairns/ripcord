import { Loader2, WifiOff } from 'lucide-react';
import { memo, useEffect, useState, useSyncExternalStore } from 'react';
import {
	getServerReconnectIndicatorDelayMs,
	getServerReconnectIndicatorText,
} from '@/features/server/server-reconnect-indicator';
import { useServerConnectionSelector } from '@/features/server/use-server-connection';
import { isVoiceReconnectOnline } from '@/features/server/voice/reconnect-lab-debug';

const subscribeOnline = (listener: () => void) => {
	window.addEventListener('online', listener);
	window.addEventListener('offline', listener);
	return () => {
		window.removeEventListener('online', listener);
		window.removeEventListener('offline', listener);
	};
};

const ServerReconnectStatus = memo(() => {
	const phase = useServerConnectionSelector((state) => state.phase);
	const online = useSyncExternalStore(subscribeOnline, isVoiceReconnectOnline, isVoiceReconnectOnline);
	const [visible, setVisible] = useState(() => getServerReconnectIndicatorDelayMs(phase, performance.now()) === 0);

	useEffect(() => {
		const delayMs = getServerReconnectIndicatorDelayMs(phase, performance.now());
		if (delayMs === undefined) {
			setVisible(false);
			return;
		}
		if (delayMs === 0) {
			setVisible(true);
			return;
		}
		setVisible(false);
		const timeoutId = window.setTimeout(() => setVisible(true), delayMs);
		return () => window.clearTimeout(timeoutId);
	}, [phase]);

	if (phase.name !== 'recovering' || !visible) return null;
	const { title, detail } = getServerReconnectIndicatorText(online);

	return (
		<div role="status" aria-live="polite" className="px-3 py-3 animate-in fade-in duration-200">
			<div className="flex items-center gap-3 rounded-md border border-warning/20 bg-warning/10 px-3 py-2.5">
				<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/12">
					{online ? (
						<Loader2 className="h-4 w-4 animate-spin text-warning" />
					) : (
						<WifiOff className="h-4 w-4 text-warning" />
					)}
				</div>
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-semibold text-foreground">{title}</p>
					<p className="truncate text-xs text-warning/90">{detail}</p>
				</div>
			</div>
		</div>
	);
});

export { ServerReconnectStatus };
