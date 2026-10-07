import type { TDesktopBridge, TDesktopPushKeybindEvent, TDesktopPushKeybindsInput } from '@/runtime/types';
import {
	clearHeldPushMicState,
	resolveHeldPushMicTarget,
	resolvePushMicState,
	type TPushMicState,
	updatePushMicStateForKeyEvent,
} from './push-mic-state';

type TPushMicKeybindInputs = TDesktopPushKeybindsInput & {
	currentVoiceChannelId: number | undefined;
	canSpeak: boolean;
	micMuted: boolean;
	soundMuted: boolean;
	pushReleaseDelayMs: number;
	setMicMuted: (micMuted: boolean, options: { playSound: false }) => Promise<void>;
};

type TPushMicKeybindControllerPorts = {
	getInputs: () => TPushMicKeybindInputs;
	getDesktopBridge: () =>
		| Pick<TDesktopBridge, 'setGlobalPushKeybinds' | 'subscribeGlobalPushKeybindEvents'>
		| undefined;
	setTimeout: (callback: () => void, milliseconds: number) => number;
	clearTimeout: (handle: number) => void;
	log: (message: string, context: object) => void;
	warn: (message: string) => void;
};

const createPushMicKeybindController = (ports: TPushMicKeybindControllerPorts) => {
	let state: TPushMicState = {
		isPushToTalkHeld: false,
		isPushToMuteHeld: false,
		micMutedBeforePush: undefined,
	};
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

	const applyOverride = (): void => {
		const inputs = ports.getInputs();
		const resolution = resolvePushMicState(state, inputs.soundMuted);

		if (resolution.targetMicMuted !== undefined) {
			void inputs.setMicMuted(resolution.targetMicMuted, { playSound: false });
		}
		if (resolution.shouldClearMicMutedBeforePush) {
			state = { ...state, micMutedBeforePush: undefined };
		}
	};

	const clearHeldKeys = (): void => {
		clearPendingRelease();
		state = clearHeldPushMicState(state);
		applyOverride();
	};

	const reconcileChannelPermission = (currentVoiceChannelId: number | undefined, canSpeak: boolean): void => {
		if (currentVoiceChannelId === undefined || !canSpeak) {
			clearHeldKeys();
		}
	};

	const reconcileConfirmedMicMuted = (confirmedMicMuted: boolean | undefined): void => {
		const pushTarget = resolveHeldPushMicTarget(state);
		if (pushTarget === undefined || state.micMutedBeforePush === undefined || confirmedMicMuted === undefined) {
			return;
		}
		if (confirmedMicMuted !== pushTarget) {
			state = { ...state, micMutedBeforePush: confirmedMicMuted };
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
			state = updatePushMicStateForKeyEvent(state, event, ports.getInputs().micMuted);
			applyOverride();
		};

		const removeSubscription = desktopBridge.subscribeGlobalPushKeybindEvents((event) => {
			if (!mounted) return;
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
			void desktopBridge.setGlobalPushKeybinds({}).catch((error: unknown) => {
				ports.log('Failed to clear global push keybinds', { error });
			});
		};
		cleanupMount = cleanup;
		return cleanup;
	};

	return { mount, reconcileChannelPermission, reconcileConfirmedMicMuted };
};

type TPushMicKeybindController = ReturnType<typeof createPushMicKeybindController>;

const mountPushMicKeybindController = (
	controller: TPushMicKeybindController,
	keybinds: TDesktopPushKeybindsInput,
): (() => void) => controller.mount(keybinds);

export type { TPushMicKeybindControllerPorts, TPushMicKeybindInputs };
export { createPushMicKeybindController, mountPushMicKeybindController };
