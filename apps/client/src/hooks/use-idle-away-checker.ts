import { type TUserPresenceStatus, UserStatus } from '@sharkord/shared';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { currentVoiceChannelIdSelector } from '@/features/server/channels/selectors';
import { useServerStore } from '@/features/server/slice';
import { updateUser } from '@/features/server/users/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import { leaveVoice } from '@/features/server/voice/actions';
import { logVoice } from '@/helpers/browser-logger';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
// OS idle time does not reset while talking, so keep the AFK voice kick well
// above the presence threshold to avoid yanking long-conversation participants.
const AFK_VOICE_THRESHOLD_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 1000;

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'] as const;

export const useIdleAwayChecker = () => {
	const userId = useOwnUserId();
	const lastActivityRef = useRef<number>(Date.now());
	const lastSentRef = useRef<TUserPresenceStatus | null>(null);
	const afkKickArmedRef = useRef(true);
	const afkKickInFlightRef = useRef(false);

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

		const maybeKickFromVoice = async (idleMs: number) => {
			if (idleMs < AFK_VOICE_THRESHOLD_MS) {
				// Re-arm for the next idle cycle, but never while a kick is still
				// in flight — otherwise a slow leaveVoice() racing the next tick
				// could fire a second concurrent kick.
				if (!afkKickInFlightRef.current) {
					afkKickArmedRef.current = true;
				}
				return;
			}

			if (!afkKickArmedRef.current || afkKickInFlightRef.current) return;

			const currentChannelId = currentVoiceChannelIdSelector(useServerStore.getState());
			if (currentChannelId === undefined) return;

			afkKickArmedRef.current = false;
			afkKickInFlightRef.current = true;
			logVoice('AFK auto-leave triggered', { idleMs, channelId: currentChannelId });
			toast.info('Disconnected from voice after an hour of inactivity.');
			try {
				await leaveVoice();
			} finally {
				afkKickInFlightRef.current = false;
			}
		};

		const checkIdle = async () => {
			const idleMs = await resolveIdleMs();
			const nextStatus: TUserPresenceStatus = idleMs >= IDLE_THRESHOLD_MS ? UserStatus.AWAY : UserStatus.ONLINE;

			void sendAutoStatus(nextStatus);
			void maybeKickFromVoice(idleMs);
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
			afkKickArmedRef.current = true;
			afkKickInFlightRef.current = false;
		};
	}, [userId]);
};
