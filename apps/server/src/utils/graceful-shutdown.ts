import { logger } from '../logger';
import { flushSentry } from '../sentry';

// How long to let the "please reconnect" broadcast flush and in-flight requests
// settle before we tear connections down. Kept short so shutdown stays well
// inside the orchestrator's SIGKILL grace (Docker/systemd default ~10s).
const SHUTDOWN_DRAIN_MS = 3_000;

type TShutdownResources = {
	// Tell connected clients to reconnect (tRPC broadcastReconnectNotification).
	broadcastReconnect?: () => void;
	// Stop accepting new connections (HTTP + WS).
	closeServers?: () => void | Promise<void>;
	// Release the mediasoup worker.
	closeMedia?: () => void | Promise<void>;
	// Checkpoint + close the database.
	closeDb?: () => void;
};

type TShutdownDeps = {
	flush: () => Promise<void>;
	exit: (code: number) => void;
	sleep: (ms: number) => Promise<void>;
	drainMs: number;
};

let resources: TShutdownResources = {};
let shuttingDown = false;

const setShutdownResources = (next: TShutdownResources): void => {
	resources = next;
};

// 128 + signal number (SIGINT → 130, SIGTERM → 143) so a shell / CI harness sees
// the process was terminated by a signal rather than a clean exit.
const exitCodeForSignal = (signal: NodeJS.Signals): number => (signal === 'SIGINT' ? 130 : 143);

const runStep = async (label: string, step: () => void | Promise<void>): Promise<void> => {
	try {
		await step();
	} catch (error) {
		// Never let one failing step abort the rest of the shutdown.
		logger.error('Graceful shutdown: %s failed', label, error);
	}
};

// Exported for testing — all side effects are injected via `deps` so the
// ordering and best-effort semantics can be asserted without real signals,
// timers, or process.exit.
const performGracefulShutdown = async (
	signal: NodeJS.Signals,
	current: TShutdownResources,
	deps: TShutdownDeps,
): Promise<void> => {
	logger.info('Graceful shutdown initiated by %s', signal);

	// 1. Stop accepting new connections before asking existing clients to
	//    reconnect. tRPC reacts to the reconnect notification immediately; if the
	//    listener remains open, clients can restore against this draining process
	//    and then start an overlapping second recovery when it exits.
	if (current.closeServers) {
		await runStep('closeServers', current.closeServers);
	}

	// 2. Ask connected clients to reconnect, then drain briefly so the
	//    notification flushes before media and database resources are released.
	if (current.broadcastReconnect) {
		await runStep('broadcastReconnect', current.broadcastReconnect);
		await deps.sleep(deps.drainMs);
	}

	// 3. Release media + database handles cleanly (worker, WAL checkpoint).
	if (current.closeMedia) {
		await runStep('closeMedia', current.closeMedia);
	}

	if (current.closeDb) {
		await runStep('closeDb', current.closeDb);
	}

	// 4. Flush telemetry last, then exit.
	await runStep('flush', deps.flush);

	deps.exit(exitCodeForSignal(signal));
};

const handleSignal = (signal: NodeJS.Signals): void => {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;

	void performGracefulShutdown(signal, resources, {
		flush: flushSentry,
		exit: (code) => process.exit(code),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		drainMs: SHUTDOWN_DRAIN_MS,
	});
};

// Register early (before the boot steps) so termination during startup still
// flushes and exits cleanly. Resources are filled in once the servers are up;
// a signal received before then simply skips the (absent) drain steps.
const registerGracefulShutdown = (): void => {
	process.once('SIGTERM', () => handleSignal('SIGTERM'));
	process.once('SIGINT', () => handleSignal('SIGINT'));
};

export { performGracefulShutdown, registerGracefulShutdown, setShutdownResources, type TShutdownResources };
