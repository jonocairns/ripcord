import type http from 'node:http';
import type { TServerInfo } from '@sharkord/shared';
import { config } from '../config';
import { getSettings } from '../db/queries/server';
import { SERVER_VERSION } from '../utils/env';

const infoRouteHandler = async (_req: http.IncomingMessage, res: http.ServerResponse) => {
	const settings = await getSettings();
	const clientTracingSampleRate =
		config.server.clientTracingSampleRate > 0 ? config.server.clientTracingSampleRate : undefined;

	const info: TServerInfo = {
		serverId: settings.serverId,
		version: SERVER_VERSION,
		name: settings.name,
		description: settings.description,
		logo: settings.logo,
		allowNewUsers: settings.allowNewUsers,
		clientErrorReporting: config.server.clientErrorReportingSentryDsn.trim()
			? {
					provider: 'sentry',
					dsn: config.server.clientErrorReportingSentryDsn.trim(),
					...(clientTracingSampleRate !== undefined ? { tracingSampleRate: clientTracingSampleRate } : {}),
					ignoreErrors: config.server.clientErrorReportingIgnoreErrors
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean),
				}
			: undefined,
	};

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(info));
};

export { infoRouteHandler };
