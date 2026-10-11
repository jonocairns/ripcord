import { config, SERVER_PRIVATE_IPS, SERVER_PUBLIC_IPS } from '../config';
import * as serverPaths from '../helpers/paths';
import { logger } from '../logger';
import * as envVars from './env';

const printDebug = () => {
	if (!config.server.debug) return;
	logger.debug({
		message: 'Server debug configuration',
		bunVersion: Bun.version_with_sha,
		localAddresses: SERVER_PRIVATE_IPS,
		publicAddresses: SERVER_PUBLIC_IPS,
		serverPaths,
		config: {
			...config,
			server: {
				...config.server,
				clientErrorReportingSentryDsn: '[redacted]',
				serverErrorReportingSentryDsn: '[redacted]',
				clientTracingSentryDsn: '[redacted]',
				serverTracingSentryDsn: '[redacted]',
				tracingOtlpHeaders: '[redacted]',
			},
		},
		environment: envVars,
	});
	logger.warn('Debug mode is enabled. This may affect performance.');
};

export { printDebug };
