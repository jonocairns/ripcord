import type http from 'node:http';
import { pingDb } from '../db';
import { mediaSoupWorker } from '../utils/mediasoup';

// Real readiness check, not a bare 200. A load balancer / orchestrator must stop
// routing to (and restart) an instance whose database is unreachable or whose
// media worker has died — both of which leave the process "up" but unable to
// serve. Returns 503 so those failures are actionable rather than silent.
const healthRouteHandler = (_req: http.IncomingMessage, res: http.ServerResponse) => {
	const checks = {
		db: pingDb(),
		mediasoup: !!mediaSoupWorker && !mediaSoupWorker.closed,
	};

	const ready = checks.db && checks.mediasoup;

	res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
	res.end(
		JSON.stringify({
			status: ready ? 'ok' : 'unavailable',
			checks,
			timestamp: Date.now(),
		}),
	);
};

export { healthRouteHandler };
