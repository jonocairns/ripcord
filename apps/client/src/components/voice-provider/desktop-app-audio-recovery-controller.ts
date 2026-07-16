type TDesktopAppAudioRecoveryLease = {
	isCurrent: () => boolean;
};

type TDesktopAppAudioRecoveryLifecycle = {
	activate: () => void;
	deactivate: () => void;
};

type TDesktopAppAudioRecoveryController = TDesktopAppAudioRecoveryLifecycle & {
	recover: (run: (lease: TDesktopAppAudioRecoveryLease) => Promise<void>) => Promise<void>;
};

const createDesktopAppAudioRecoveryController = (): TDesktopAppAudioRecoveryController => {
	let active = false;
	let lifecycleGeneration = 0;
	let pendingRecovery: Promise<void> | undefined;

	const activate = (): void => {
		if (active) {
			return;
		}

		active = true;
		lifecycleGeneration += 1;
	};

	const deactivate = (): void => {
		if (!active) {
			return;
		}

		active = false;
		lifecycleGeneration += 1;
	};

	const recover = (run: (lease: TDesktopAppAudioRecoveryLease) => Promise<void>): Promise<void> => {
		const ownedLifecycleGeneration = lifecycleGeneration;
		const lease: TDesktopAppAudioRecoveryLease = {
			isCurrent: () => active && lifecycleGeneration === ownedLifecycleGeneration,
		};
		const previousRecovery = pendingRecovery;

		const recovery = (async () => {
			if (previousRecovery) {
				await previousRecovery.catch(() => undefined);
			}

			if (!lease.isCurrent()) {
				return;
			}

			await run(lease);
		})().finally(() => {
			if (pendingRecovery === recovery) {
				pendingRecovery = undefined;
			}
		});

		pendingRecovery = recovery;
		return recovery;
	};

	return { activate, deactivate, recover };
};

export {
	createDesktopAppAudioRecoveryController,
	type TDesktopAppAudioRecoveryController,
	type TDesktopAppAudioRecoveryLease,
	type TDesktopAppAudioRecoveryLifecycle,
};
