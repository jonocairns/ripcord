import { type TUserPresenceStatus, UserStatus } from '@sharkord/shared';
import { useEffect, useRef } from 'react';
import { updateUser } from '@/features/server/users/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 1000;

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'] as const;

export const useIdleAwayChecker = () => {
	const userId = useOwnUserId();
	const lastActivityRef = useRef<number>(Date.now());
	const lastSentRef = useRef<TUserPresenceStatus | null>(null);

	useEffect(() => {
		if (typeof window === 'undefined' || !userId) return;

		const desktopBridge = getDesktopBridge();

		const markActive = () => {
			lastActivityRef.current = Date.now();
		};

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				markActive();
			}
		};

		for (const event of ACTIVITY_EVENTS) {
			window.addEventListener(event, markActive, { passive: true });
		}
		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.addEventListener('focus', markActive);

		const sendAutoStatus = async (status: TUserPresenceStatus) => {
			if (lastSentRef.current === status) return;

			try {
				const trpc = getTRPCClient();
				const result = await trpc.users.setStatus.mutate({ status, auto: true });

				lastSentRef.current = status;
				updateUser(userId, { status: result.status });
			} catch {
				// Leave lastSentRef unchanged so the next tick retries.
			}
		};

		const resolveIdleMs = async (): Promise<number> => {
			if (desktopBridge) {
				try {
					const seconds = await desktopBridge.getSystemIdleSeconds();
					return seconds * 1000;
				} catch {
					// Fall through to window-event tracking on IPC failure.
				}
			}
			return Date.now() - lastActivityRef.current;
		};

		const checkIdle = async () => {
			const idleMs = await resolveIdleMs();
			const nextStatus: TUserPresenceStatus = idleMs >= IDLE_THRESHOLD_MS ? UserStatus.AWAY : UserStatus.ONLINE;

			void sendAutoStatus(nextStatus);
		};

		const intervalId = window.setInterval(() => {
			void checkIdle();
		}, CHECK_INTERVAL_MS);

		return () => {
			window.clearInterval(intervalId);
			for (const event of ACTIVITY_EVENTS) {
				window.removeEventListener(event, markActive);
			}
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.removeEventListener('focus', markActive);
			lastSentRef.current = null;
		};
	}, [userId]);
};
