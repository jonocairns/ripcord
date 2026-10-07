import type { TVoiceTransportFailureEvent } from '@sharkord/shared';

type TTransportFailureHandler = (failure?: TVoiceTransportFailureEvent) => void;

// The one late-bound edge in provider composition. Remote media detects
// transport failure, but the session runtime that handles it is built later
// because it depends on remote media's transports.
// - `report` forwards to the bound handler, and drops the report while unbound.
// - The runtime binds on activation (a layout effect, before passive executor
//   work) and releases on deactivation. Release clears only its own binding, so
//   a repeated or Strict Mode replay cleanup cannot remove its replacement.
const createTransportFailurePort = () => {
	let binding: { handle: TTransportFailureHandler } | undefined;

	const report = (failure?: TVoiceTransportFailureEvent): void => {
		binding?.handle(failure);
	};

	const bind = (handle: TTransportFailureHandler): (() => void) => {
		const ownBinding = { handle };
		binding = ownBinding;
		return () => {
			if (binding === ownBinding) binding = undefined;
		};
	};

	return { report, bind };
};

type TTransportFailurePort = ReturnType<typeof createTransportFailurePort>;

export { createTransportFailurePort, type TTransportFailurePort };
