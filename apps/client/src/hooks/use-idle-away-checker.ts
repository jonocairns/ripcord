import { type TUserPresenceStatus, UserStatus } from '@sharkord/shared';
import { useEffect, useRef } from 'react';
import { updateUser } from '@/features/server/users/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getTRPCClient } from '@/lib/trpc';

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 1000;

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'] as const;

export const useIdleAwayChecker = () => {
	const userId = useOwnUserId();
	const lastActivityRef = useRef<number>(Date.now());
	const lastSentRef = useRef<TUserPresenceStatus | null>(null);

	useEffect(() => {
		if (typeof window === 'undefined' || !userId) return;

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

		const checkIdle = () => {
			const idleMs = Date.now() - lastActivityRef.current;
			const nextStatus: TUserPresenceStatus = idleMs >= IDLE_THRESHOLD_MS ? UserStatus.AWAY : UserStatus.ONLINE;

			void sendAutoStatus(nextStatus);
		};

		const intervalId = window.setInterval(checkIdle, CHECK_INTERVAL_MS);

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
