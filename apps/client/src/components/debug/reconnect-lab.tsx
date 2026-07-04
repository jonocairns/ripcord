import { DisconnectCode } from '@sharkord/shared';
import { FlaskConical } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { currentVoiceChannelIdSelector } from '@/features/server/channels/selectors';
import { useServerStore } from '@/features/server/slice';
import {
	clearVoiceReconnectOfflineSimulation,
	getVoiceReconnectOfflineSimulationRemainingMs,
	isVoiceReconnectOfflineSimulated,
	startVoiceReconnectOfflineSimulation,
} from '@/features/server/voice/reconnect-lab-debug';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { debugCloseCurrentWs, getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';

const RECONNECT_LAB_RESTORE_DELAY_MS = 5_000;
const RECONNECT_LAB_RESTORE_FAILURE = 'VOICE_RECONNECT_LAB_FORCED_FAILURE';
const RECONNECT_LAB_OFFLINE_DURATION_MS = 70_000;
const RECONNECT_LAB_RAPID_FLAP_COUNT = 4;
const RECONNECT_LAB_RAPID_FLAP_INTERVAL_MS = 8_000;
const RECONNECT_LAB_RETRY_CLOSE_DELAY_MS = 2_000;
const RECONNECT_LAB_DESKTOP_QUIT_DELAY_MS = 1_000;

type TReconnectLabFailCode = 'INTERNAL_SERVER_ERROR' | 'UNAUTHORIZED' | 'CONFLICT';

type TReconnectLabAction =
	| 'drop-ws-short'
	| 'slow-restore'
	| 'failed-restore'
	| 'restore-conflict'
	| 'restore-unauthorized'
	| 'kick-during-restore'
	| 'ban-during-restore'
	| 'lost-session'
	| 'offline-70s'
	| 'rapid-ws-flap'
	| 'transport-failure'
	| 'desktop-quit'
	| 'desktop-quit-mid-reconnect';

const MANUAL_SCENARIOS = [
	'Server restart with more than one user in voice: restart the dev server while all clients stay in-channel.',
	'Two tabs, same user, same channel: keep tab B live, drop tab A, and confirm tab A conflicts without evicting tab B.',
	'Screen share plus webcam across a WS drop: start both captures, then use Drop WS (<60s) and verify peers do not hear leave churn.',
] as const;

const ReconnectLab = () => {
	const connected = useServerStore((state) => state.connected);
	const currentVoiceChannelId = useServerStore(currentVoiceChannelIdSelector);
	const [isOpen, setIsOpen] = useState(false);
	const [pendingAction, setPendingAction] = useState<TReconnectLabAction | undefined>();
	const [lastResult, setLastResult] = useState('Idle');
	const [statusTick, setStatusTick] = useState(() => Date.now());
	const desktopBridge = getDesktopBridge();
	const canRunVoiceScenarios = connected && currentVoiceChannelId !== undefined;
	const scheduledActionTimeoutIdsRef = useRef<number[]>([]);

	useEffect(() => {
		if (!isOpen) {
			return;
		}

		const intervalId = window.setInterval(() => {
			setStatusTick(Date.now());
		}, 1_000);

		return () => {
			window.clearInterval(intervalId);
		};
	}, [isOpen]);

	useEffect(() => {
		return () => {
			scheduledActionTimeoutIdsRef.current.forEach((timeoutId) => {
				window.clearTimeout(timeoutId);
			});
		};
	}, []);

	const runAction = async (action: TReconnectLabAction, label: string, fn: () => Promise<string>) => {
		setPendingAction(action);

		try {
			const message = await fn();
			setLastResult(message);
			toast.success(label, {
				description: message,
			});
		} catch (error) {
			const message = getTrpcError(error, `${label} failed`);
			setLastResult(message);
			toast.error(message);
		} finally {
			setPendingAction(undefined);
		}
	};

	const clearScheduledActionTimeouts = () => {
		scheduledActionTimeoutIdsRef.current.forEach((timeoutId) => {
			window.clearTimeout(timeoutId);
		});
		scheduledActionTimeoutIdsRef.current = [];
	};

	const closeCurrentWs = (opts: { code?: number; reason?: string } = {}) => {
		if (!debugCloseCurrentWs({ code: opts.code ?? 4013, reason: opts.reason ?? 'voice reconnect lab' })) {
			throw new Error('The tRPC websocket is not currently open.');
		}
	};

	const runReconnectScenario = async (opts: {
		delayMs?: number;
		failCode?: TReconnectLabFailCode;
		failMessage?: string;
		closeWsCode?: number;
		closeWsReason?: string;
		forgetOwnVoiceSession?: boolean;
		closeCurrentWsCode?: number;
		closeCurrentWsReason?: string;
	}) => {
		const client = getTRPCClient();
		const shouldPrimeRestoreBehavior =
			opts.delayMs !== undefined ||
			opts.failCode !== undefined ||
			opts.failMessage !== undefined ||
			opts.closeWsCode !== undefined;

		if (shouldPrimeRestoreBehavior) {
			await client.voice.reconnectLab.setNextRestoreBehavior.mutate({
				delayMs: opts.delayMs,
				failCode: opts.failCode,
				failMessage: opts.failMessage,
				closeWsCode: opts.closeWsCode,
				closeWsReason: opts.closeWsReason,
			});
		}

		try {
			if (opts.forgetOwnVoiceSession) {
				const result = await client.voice.reconnectLab.forgetOwnVoiceSession.mutate();

				if (!result.forgotten) {
					throw new Error('You must already be in voice to forget the server session.');
				}
			}

			closeCurrentWs({
				code: opts.closeCurrentWsCode,
				reason: opts.closeCurrentWsReason,
			});
		} catch (error) {
			if (shouldPrimeRestoreBehavior) {
				void client.voice.reconnectLab.clearNextRestoreBehavior.mutate().catch(() => undefined);
			}

			throw error;
		}
	};

	const scheduleActionTimeout = (callback: () => void, delayMs: number) => {
		const timeoutId = window.setTimeout(() => {
			scheduledActionTimeoutIdsRef.current = scheduledActionTimeoutIdsRef.current.filter((id) => id !== timeoutId);
			callback();
		}, delayMs);
		scheduledActionTimeoutIdsRef.current.push(timeoutId);
	};

	const startRapidWsFlapScenario = () => {
		clearScheduledActionTimeouts();

		for (let attempt = 0; attempt < RECONNECT_LAB_RAPID_FLAP_COUNT; attempt += 1) {
			scheduleActionTimeout(() => {
				void Promise.resolve().then(() => {
					debugCloseCurrentWs({
						code: 4013,
						reason: `voice reconnect lab flap ${attempt + 1}`,
					});
				});
			}, attempt * RECONNECT_LAB_RAPID_FLAP_INTERVAL_MS);
		}
	};

	const runOfflineReconnectScenario = async () => {
		startVoiceReconnectOfflineSimulation(RECONNECT_LAB_OFFLINE_DURATION_MS);

		try {
			closeCurrentWs();
		} catch (error) {
			clearVoiceReconnectOfflineSimulation();
			throw error;
		}
	};

	const formatDurationSeconds = (durationMs: number) => {
		return Math.max(1, Math.ceil(durationMs / 1_000));
	};

	const offlineSimulationActive = isVoiceReconnectOfflineSimulated(statusTick);
	const offlineSimulationRemainingMs = getVoiceReconnectOfflineSimulationRemainingMs(statusTick);

	if (!import.meta.env.DEV) {
		return null;
	}

	if (!isOpen) {
		return (
			<div className="fixed bottom-3 right-3 z-40">
				<Button
					size="icon"
					variant="outline"
					aria-label="Open reconnect lab"
					title="Reconnect Lab"
					onClick={() => setIsOpen(true)}
				>
					<FlaskConical className="size-4" />
				</Button>
			</div>
		);
	}

	return (
		<div className="fixed bottom-3 right-3 z-40 max-h-[calc(100vh-1.5rem)] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto rounded-md border bg-background/95 p-3 shadow-lg backdrop-blur">
			<div className="mb-3 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-sm font-semibold">Reconnect Lab</p>
					<p className="text-xs text-muted-foreground">
						Socket {connected ? 'connected' : 'disconnected'}
						{' · '}
						{currentVoiceChannelId === undefined ? 'not in voice' : `voice #${currentVoiceChannelId}`}
					</p>
					{offlineSimulationActive ? (
						<p className="text-xs text-warning">
							Synthetic offline active for about {formatDurationSeconds(offlineSimulationRemainingMs)}s
						</p>
					) : null}
				</div>
				<Button size="sm" variant="ghost" onClick={() => setIsOpen(false)}>
					Hide
				</Button>
			</div>

			<div className="grid gap-2">
				<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Single client faults</p>
				<Button
					size="sm"
					variant="outline"
					disabled={!connected || pendingAction !== undefined}
					onClick={() => {
						void runAction('drop-ws-short', 'Drop WS', async () => {
							closeCurrentWs();
							return 'Closed the tRPC websocket without any server-side fault injection. This is the pure WS drop case.';
						});
					}}
				>
					Drop WS (&lt;60s)
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={!canRunVoiceScenarios || pendingAction !== undefined}
					onClick={() => {
						void runAction('slow-restore', 'Slow restore', async () => {
							await runReconnectScenario({
								delayMs: RECONNECT_LAB_RESTORE_DELAY_MS,
							});

							return `Primed a ${RECONNECT_LAB_RESTORE_DELAY_MS / 1000}s restore delay, then closed the websocket.`;
						});
					}}
				>
					Slow restore + drop WS
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={!canRunVoiceScenarios || pendingAction !== undefined}
					onClick={() => {
						void runAction('failed-restore', 'Failed restore', async () => {
							await runReconnectScenario({
								failMessage: RECONNECT_LAB_RESTORE_FAILURE,
							});

							return 'Primed one forced restore failure, then closed the websocket so the retry loop can recover.';
						});
					}}
				>
					Fail next restore + drop WS
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={!canRunVoiceScenarios || pendingAction !== undefined}
					onClick={() => {
						void runAction('restore-conflict', 'Restore conflict', async () => {
							await runReconnectScenario({
								failCode: 'CONFLICT',
								failMessage: 'VOICE_SESSION_OWNED_ELSEWHERE',
							});

							return 'Forced the next restoreOrJoin call to return CONFLICT so the client can exercise terminal conflict handling.';
						});
					}}
				>
					Force restore conflict
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={!canRunVoiceScenarios || pendingAction !== undefined}
					onClick={() => {
						void runAction('restore-unauthorized', 'Unauthorized restore', async () => {
							await runReconnectScenario({
								delayMs: RECONNECT_LAB_RETRY_CLOSE_DELAY_MS,
								failCode: 'UNAUTHORIZED',
								failMessage: 'VOICE_RECONNECT_LAB_UNAUTHORIZED',
							});

							return 'Forced the next restoreOrJoin call to fail as UNAUTHORIZED after the reconnect retry starts.';
						});
					}}
				>
					Unauthorized during restore
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={!canRunVoiceScenarios || pendingAction !== undefined}
					onClick={() => {
						void runAction('kick-during-restore', 'Kick during restore', async () => {
							await runReconnectScenario({
								delayMs: RECONNECT_LAB_RETRY_CLOSE_DELAY_MS,
								closeWsCode: DisconnectCode.KICKED,
								closeWsReason: 'voice reconnect lab kick',
							});

							return 'Primed a reconnect restore delay, then the server closes the reconnected WS with the KICKED code.';
						});
					}}
				>
					Kick during restore
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={!canRunVoiceScenarios || pendingAction !== undefined}
					onClick={() => {
						void runAction('ban-during-restore', 'Ban during restore', async () => {
							await runReconnectScenario({
								delayMs: RECONNECT_LAB_RETRY_CLOSE_DELAY_MS,
								closeWsCode: DisconnectCode.BANNED,
								closeWsReason: 'voice reconnect lab ban',
							});

							return 'Primed a reconnect restore delay, then the server closes the reconnected WS with the BANNED code.';
						});
					}}
				>
					Ban during restore
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={!canRunVoiceScenarios || pendingAction !== undefined}
					onClick={() => {
						void runAction('lost-session', 'Lost session', async () => {
							await runReconnectScenario({
								forgetOwnVoiceSession: true,
							});

							return 'Forgot the server-side voice session and closed the websocket. The reconnect should take the join branch.';
						});
					}}
				>
					Forget session + drop WS
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={!canRunVoiceScenarios || pendingAction !== undefined}
					onClick={() => {
						void runAction('offline-70s', 'Offline 70s', async () => {
							await runOfflineReconnectScenario();
							return 'Started a synthetic 70-second offline pause and closed the websocket. Reconnect retries should stay paused until the lab brings you back online.';
						});
					}}
				>
					Offline 70s + drop WS
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={!canRunVoiceScenarios || pendingAction !== undefined}
					onClick={() => {
						void runAction('rapid-ws-flap', 'Rapid WS flap', async () => {
							startRapidWsFlapScenario();
							return `Scheduled ${RECONNECT_LAB_RAPID_FLAP_COUNT} websocket drops over ${formatDurationSeconds(
								(RECONNECT_LAB_RAPID_FLAP_COUNT - 1) * RECONNECT_LAB_RAPID_FLAP_INTERVAL_MS,
							)} seconds.`;
						});
					}}
				>
					Rapid WS flap x4
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={!canRunVoiceScenarios || pendingAction !== undefined}
					onClick={() => {
						void runAction('transport-failure', 'Transport failure', async () => {
							const result = await getTRPCClient().voice.reconnectLab.emitTransportFailed.mutate();

							if (!result.emitted) {
								throw new Error('You must be in voice to simulate a transport failure.');
							}

							return 'Emitted VOICE_TRANSPORT_FAILED for the current user.';
						});
					}}
				>
					Emit transport failure (ICE-only)
				</Button>

				{desktopBridge?.debugRequestBeforeQuitFlush ? (
					<>
						<Separator className="my-1" />
						<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Desktop</p>
						<Button
							size="sm"
							variant="outline"
							disabled={pendingAction !== undefined}
							onClick={() => {
								void runAction('desktop-quit', 'Desktop quit flush', async () => {
									const result = await desktopBridge.debugRequestBeforeQuitFlush?.();

									if (!result) {
										throw new Error('Desktop quit flush is unavailable in this runtime.');
									}

									return result.status === 'succeeded'
										? 'Renderer quit flush completed without quitting the desktop app.'
										: `Quit flush skipped (${result.reason ?? 'unknown'}).`;
								});
							}}
						>
							Run desktop quit flush
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={!canRunVoiceScenarios || pendingAction !== undefined}
							onClick={() => {
								void runAction('desktop-quit-mid-reconnect', 'Quit mid-reconnect', async () => {
									await runReconnectScenario({
										delayMs: RECONNECT_LAB_RESTORE_DELAY_MS,
									});
									await new Promise<void>((resolve) => {
										window.setTimeout(resolve, RECONNECT_LAB_DESKTOP_QUIT_DELAY_MS);
									});

									const result = await desktopBridge.debugRequestBeforeQuitFlush?.();

									if (!result) {
										throw new Error('Desktop quit flush is unavailable in this runtime.');
									}

									return result.status === 'succeeded'
										? 'Started a reconnect retry and then flushed desktop quit during the retry window.'
										: `Started a reconnect retry, but the desktop quit flush was skipped (${result.reason ?? 'unknown'}).`;
								});
							}}
						>
							Drop WS then desktop quit
						</Button>
					</>
				) : null}
			</div>

			<Separator className="my-3" />

			<div className="grid gap-2">
				<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Manual checks</p>
				{MANUAL_SCENARIOS.map((scenario) => (
					<p key={scenario} className="text-xs text-muted-foreground">
						{scenario}
					</p>
				))}
			</div>

			<p className="mt-3 text-xs text-muted-foreground">
				{lastResult}
				{!canRunVoiceScenarios ? ' Join a voice channel to enable the voice-only scenarios.' : ''}
			</p>
		</div>
	);
};

export { ReconnectLab };
