import type { StreamKind } from '@sharkord/shared';
import type { TRemoteMediaSubscriptions } from './remote-media-subscriptions';
import { getPendingStreamKey } from './use-pending-streams';

type TConsumeStartPublicationRequest = {
	remoteId: number;
	kind: StreamKind;
	expectedProducerId?: string;
};

type TConsumeStartPublicationWaiter = {
	key: string;
	operationToken: number;
	expectedProducerId?: string;
	settle: (isCurrent: boolean) => void;
};

const createRemoteMediaConsumeStartPublication = () => {
	const waiters = new Map<number, TConsumeStartPublicationWaiter>();
	let disposed = false;

	const wait = (
		request: TConsumeStartPublicationRequest,
		operationToken: number,
		signal: AbortSignal,
	): Promise<boolean> => {
		if (disposed || signal.aborted) return Promise.resolve(false);

		return new Promise<boolean>((resolve) => {
			const settle = (isCurrent: boolean): void => {
				const waiter = waiters.get(operationToken);
				if (waiter?.settle !== settle) return;

				waiters.delete(operationToken);
				signal.removeEventListener('abort', onAbort);
				resolve(isCurrent);
			};
			const onAbort = () => settle(false);

			waiters.set(operationToken, {
				key: getPendingStreamKey(request.remoteId, request.kind),
				operationToken,
				expectedProducerId: request.expectedProducerId,
				settle,
			});
			signal.addEventListener('abort', onAbort, { once: true });
		});
	};

	const reconcile = (subscriptions: TRemoteMediaSubscriptions): void => {
		waiters.forEach((waiter) => {
			const subscription = subscriptions.get(waiter.key);
			const producerMatches =
				waiter.expectedProducerId === undefined ||
				subscription?.producerId === undefined ||
				subscription.producerId === waiter.expectedProducerId;

			waiter.settle(
				subscription?.consumeGeneration === waiter.operationToken && subscription.producerPresent && producerMatches,
			);
		});
	};

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;

		const currentWaiters = [...waiters.values()];
		currentWaiters.forEach((waiter) => waiter.settle(false));
	};

	return { wait, reconcile, dispose };
};

type TRemoteMediaConsumeStartPublication = ReturnType<typeof createRemoteMediaConsumeStartPublication>;

export type { TRemoteMediaConsumeStartPublication };
export { createRemoteMediaConsumeStartPublication };
