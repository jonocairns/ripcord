import { closeDb } from '../db';
import { createHttpServer } from '../http';
import { setShutdownResources } from './graceful-shutdown';
import { mediaSoupWorker } from './mediasoup';
import { createWsServer } from './wss';

const createServers = async () => {
	const httpServer = await createHttpServer();

	const { wss, broadcastReconnect } = await createWsServer(httpServer);

	// Hand the live server/worker/db handles to the graceful-shutdown orchestrator
	// so SIGTERM/SIGINT drains connections and releases resources cleanly. The
	// process exits right after, so closeServers just needs to stop accepting new
	// connections — it does not block on existing ones draining fully.
	setShutdownResources({
		broadcastReconnect,
		closeServers: () => {
			wss.close();
			httpServer.close();
		},
		closeMedia: () => {
			// `mediaSoupWorker` is a `let` that is undefined until loadMediasoup
			// runs; guard even though the boot order makes it set by this point.
			if (mediaSoupWorker && !mediaSoupWorker.closed) {
				mediaSoupWorker.close();
			}
		},
		closeDb,
	});
};

export { createServers };
