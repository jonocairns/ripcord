import type { TOwnPushHold } from '@/features/server/voice/own-voice-state';
import type { TDesktopBridge, TDesktopPushKeybindEvent, TDesktopPushKeybindsInput } from '@/runtime/types';

type TPushMicKeybindInputs = TDesktopPushKeybindsInput & {
	currentVoiceChannelId: number | undefined;
	canSpeak: boolean;
	pushReleaseDelayMs: number;
};

type TPushMicKeybindControllerPorts = {
	getInputs: () => TPushMicKeybindInputs;
	getHold: () => TOwnPushHold;
	setHold: (hold: TOwnPushHold) => void;
	getDesktopBridge: () =>
		| Pick<TDesktopBridge, 'setGlobalPushKeybinds' | 'subscribeGlobalPushKeybindEvents'>
		| undefined;
	setTimeout: (callback: () => void, milliseconds: number) => number;
	clearTimeout: (handle: number) => void;
	log: (message: string, context: object) => void;
	warn: (message: string) => void;
};

const createPushMicKeybindController = (ports: TPushMicKeybindControllerPorts) => {
	const physicalDown = { talk: false, mute: false };
	const releaseTimers: Partial<Record<TDesktopPushKeybindEvent['kind'], number>> = {};
	let cleanupMount: (() => void) | undefined;

	const clearPendingRelease = (kind?: TDesktopPushKeybindEvent['kind']): void => {
		const kinds = kind === undefined ? (['talk', 'mute'] as const) : [kind];
		for (const key of kinds) {
			const timer = releaseTimers[key];
			if (timer !== undefined) {
				delete releaseTimers[key];
				ports.clearTimeout(timer);
			}
		}
	};

	const clearHeldKeys = (): void => {
		clearPendingRelease();
		const hold = ports.getHold();
		if (hold.talk || hold.mute) ports.setHold({ talk: false, mute: false });
	};

	const reconcileChannelPermission = (currentVoiceChannelId: number | undefined, canSpeak: boolean): void => {
		if (currentVoiceChannelId === undefined || !canSpeak) {
			clearHeldKeys();
		}
	};

	const mount = (keybinds: TDesktopPushKeybindsInput): (() => void) => {
		cleanupMount?.();
		const desktopBridge = ports.getDesktopBridge();
		if (!desktopBridge) {
			return () => {};
		}
		let mounted = true;
		const { pushToTalkKeybind, pushToMuteKeybind } = keybinds;
		void desktopBridge
			.setGlobalPushKeybinds({ pushToTalkKeybind, pushToMuteKeybind })
			.then((result) => {
				if (!mounted) return;
				const firstError = result.errors[0];
				if (firstError !== undefined) {
					ports.log('Global push keybind registration issues', result);
					ports.warn(firstError);
				}
			})
			.catch((error: unknown) => {
				if (mounted) ports.log('Failed to register global push keybinds', { error });
			});

		const applyEvent = (event: TDesktopPushKeybindEvent): void => {
			if (ports.getHold()[event.kind] === event.active) return;
			ports.setHold({ ...ports.getHold(), [event.kind]: event.active });
		};

		const removeSubscription = desktopBridge.subscribeGlobalPushKeybindEvents((event) => {
			if (!mounted) return;
			if (event.active && physicalDown[event.kind]) return;
			physicalDown[event.kind] = event.active;
			const inputs = ports.getInputs();
			if (inputs.currentVoiceChannelId === undefined || !inputs.canSpeak) {
				clearHeldKeys();
				return;
			}

			// Only events for this key supersede its pending release. The other
			// key must retain its timer and held state until its own release.
			clearPendingRelease(event.kind);
			if (!event.active && inputs.pushReleaseDelayMs > 0) {
				const timer = ports.setTimeout(() => {
					if (!mounted || releaseTimers[event.kind] !== timer) return;
					delete releaseTimers[event.kind];
					const latestInputs = ports.getInputs();
					if (latestInputs.currentVoiceChannelId === undefined || !latestInputs.canSpeak) {
						clearHeldKeys();
						return;
					}
					applyEvent(event);
				}, inputs.pushReleaseDelayMs);
				releaseTimers[event.kind] = timer;
				return;
			}
			applyEvent(event);
		});

		const cleanup = (): void => {
			if (!mounted) return;
			mounted = false;
			cleanupMount = undefined;
			removeSubscription();
			clearHeldKeys();
			physicalDown.talk = false;
			physicalDown.mute = false;
			void desktopBridge.setGlobalPushKeybinds({}).catch((error: unknown) => {
				ports.log('Failed to clear global push keybinds', { error });
			});
		};
		cleanupMount = cleanup;
		return cleanup;
	};

	return { mount, reconcileChannelPermission };
};

type TPushMicKeybindController = ReturnType<typeof createPushMicKeybindController>;

const mountPushMicKeybindController = (
	controller: TPushMicKeybindController,
	keybinds: TDesktopPushKeybindsInput,
): (() => void) => controller.mount(keybinds);

export type { TPushMicKeybindControllerPorts, TPushMicKeybindInputs };
export { createPushMicKeybindController, mountPushMicKeybindController };
