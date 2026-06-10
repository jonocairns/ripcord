import type http from 'node:http';

const healthRouteHandler = (_req: http.IncomingMessage, res: http.ServerResponse) => {
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
};

export { healthRouteHandler };
