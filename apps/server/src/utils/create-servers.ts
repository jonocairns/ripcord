import { createHttpServer } from '../http';
import { createWsServer } from './wss';

const createServers = async () => {
	const httpServer = await createHttpServer();

	await createWsServer(httpServer);
};

export { createServers };
