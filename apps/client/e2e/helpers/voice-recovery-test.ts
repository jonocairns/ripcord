type TVoiceRecoveryTest = {
	run: () => Promise<void>;
	attachDiagnostics: () => Promise<void>;
	resumeOutage: () => void;
	disposePeers: readonly (() => Promise<void>)[];
};

const runVoiceRecoveryTest = async ({
	run,
	attachDiagnostics,
	resumeOutage,
	disposePeers,
}: TVoiceRecoveryTest): Promise<void> => {
	const failures: { operation: string; error: unknown }[] = [];
	const operations: { name: string; run: () => void | Promise<void> }[] = [
		{ name: 'Scenario', run },
		{ name: 'Diagnostics', run: attachDiagnostics },
		{ name: 'Outage release', run: resumeOutage },
		...disposePeers.map((dispose, index) => ({ name: `Peer ${index + 1} cleanup`, run: dispose })),
	];

	for (const operation of operations) {
		try {
			await operation.run();
		} catch (error) {
			failures.push({ operation: operation.name, error });
		}
	}

	const firstFailure = failures[0];
	if (!firstFailure) return;
	if (failures.length === 1) throw firstFailure.error;

	// Playwright reports Error.cause but does not expand AggregateError.errors.
	// Keep the original failure's stack and make every secondary failure visible.
	throw new AggregateError(
		failures.map(({ error }) => error),
		failures
			.map(({ operation, error }) => `${operation}: ${error instanceof Error ? error.message : String(error)}`)
			.join('\n'),
		{ cause: firstFailure.error },
	);
};

export { runVoiceRecoveryTest };
