import { chunkFileIds, type TFileAccessToken } from './file-access-tokens';

type TFileAccessTokensClient = {
	files: {
		refreshAccessTokens: {
			query: (input: { fileIds: number[] }) => Promise<TFileAccessToken[]>;
		};
	};
};

type TFileAccessRefresherDeps = {
	getClient: () => TFileAccessTokensClient;
	getServerId: () => string | undefined;
	applyTokens: (tokens: TFileAccessToken[]) => void;
	onError?: (error: unknown) => void;
};

// Re-signs attachment links the client holds, like Discord's attachment
// refresh: file URLs are built from the tokens at render time, so cards and
// media pick up the new links on their next render.
const createFileAccessRefresher = (deps: TFileAccessRefresherDeps) => {
	// IDs waiting for a request. A file asked for again while its request is in
	// flight is requested once more after it, because the in-flight request may
	// have been signed before the change that prompted the new one (a rotation).
	const pendingFileIds = new Set<number>();
	let running: Promise<void> | undefined;

	const drain = async () => {
		try {
			while (pendingFileIds.size > 0) {
				const [batch = []] = chunkFileIds([...pendingFileIds]);
				const serverId = deps.getServerId();

				for (const fileId of batch) {
					pendingFileIds.delete(fileId);
				}

				let tokens: TFileAccessToken[];

				try {
					tokens = await deps.getClient().files.refreshAccessTokens.query({ fileIds: batch });
				} catch (error) {
					// An older server without the route, or a dropped socket. Only this
					// batch keeps its current tokens; IDs other triggers queued in the
					// meantime are still requested. After a dropped socket, the rejoin
					// refresh retries everything loaded.
					deps.onError?.(error);
					continue;
				}

				// File IDs only identify files within one server. Drop a response
				// that lands after the client moved to another server.
				if (deps.getServerId() !== serverId) {
					pendingFileIds.clear();
					return;
				}

				// Each batch applies on its own: its tokens are valid whatever happens
				// to the next request.
				deps.applyTokens(tokens);
			}
		} finally {
			running = undefined;
		}
	};

	const refreshFiles = (fileIds: number[]): Promise<void> => {
		for (const fileId of fileIds) {
			pendingFileIds.add(fileId);
		}

		if (!running && pendingFileIds.size > 0) {
			running = drain();
		}

		return running ?? Promise.resolve();
	};

	return { refreshFiles };
};

export type { TFileAccessTokensClient };
export { createFileAccessRefresher };
