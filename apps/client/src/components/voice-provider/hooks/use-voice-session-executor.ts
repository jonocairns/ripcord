import { useEffect } from 'react';
import {
	createVoiceSessionCommandExecutor,
	type TVoiceSessionExecutorPorts,
} from '@/features/server/voice/voice-session-command-executor';
import {
	dispatchVoiceSession,
	getVoiceSessionState,
	registerVoiceSessionCommandRunner,
} from '@/features/server/voice/voice-session-store';
import { useLatestRef } from '@/hooks/use-latest-ref';

type TVoiceSessionExecutorPortsSource = () => TVoiceSessionExecutorPorts;

const createRefBackedExecutorPorts = (getPorts: TVoiceSessionExecutorPortsSource): TVoiceSessionExecutorPorts => ({
	now: () => getPorts().now(),
	random: () => getPorts().random(),
	delay: (milliseconds, signal) => getPorts().delay(milliseconds, signal),
	isOnline: () => getPorts().isOnline(),
	captureRecoverySnapshot: () => getPorts().captureRecoverySnapshot(),
	rebuildTransports: (command, context) => getPorts().rebuildTransports(command, context),
	restoreVoiceSession: (command, context) => getPorts().restoreVoiceSession(command, context),
	restoreWatchIntent: (snapshot) => getPorts().restoreWatchIntent(snapshot),
	recoverDesktopAppAudio: () => getPorts().recoverDesktopAppAudio(),
	leaveVoiceSession: (channelId) => getPorts().leaveVoiceSession(channelId),
	clearFailedSession: (command) => getPorts().clearFailedSession(command),
	reportCommandError: (command, error) => getPorts().reportCommandError(command, error),
	reportRebuildDetached: (command) => getPorts().reportRebuildDetached(command),
	reportRebuildTerminalFailure: (command, error) => getPorts().reportRebuildTerminalFailure(command, error),
	reportRestoreDetached: (command) => getPorts().reportRestoreDetached(command),
	commandObserver: {
		start: (context) => getPorts().commandObserver?.start(context) ?? { run: (effect) => effect(), finish: () => {} },
	},
});

// The imperative mount seam keeps lifecycle behavior testable with the real
// executor and store without requiring VoiceProvider's browser/media graph.
const mountVoiceSessionExecutor = (getPorts: TVoiceSessionExecutorPortsSource): (() => void) => {
	const executor = createVoiceSessionCommandExecutor(createRefBackedExecutorPorts(getPorts));
	const unregister = registerVoiceSessionCommandRunner(executor.execute);
	const { phase } = getVoiceSessionState();

	// Recovery-step commands are intentionally not buffered across a runner gap.
	// Reissue the current step under a fresh generation after registration so the
	// new executor owns the replacement command immediately.
	if (phase.phase === 'rebuilding' || phase.phase === 'reconnecting') {
		dispatchVoiceSession({ type: 'Resumed' });
	}

	let unmounted = false;

	return () => {
		if (unmounted) {
			return;
		}

		unmounted = true;
		unregister();
		executor.dispose();
	};
};

const useVoiceSessionExecutor = (ports: TVoiceSessionExecutorPorts): void => {
	const portsRef = useLatestRef(ports);

	useEffect(() => mountVoiceSessionExecutor(() => portsRef.current), []);
};

export { mountVoiceSessionExecutor, useVoiceSessionExecutor };
