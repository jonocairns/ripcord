// These early boot steps need to stay at the top in this order.
// bootLog is dependency-free, so it is safe to use before config/logger setup.
// keep the "---------" because it forces prettier to not mess with the order, I can't turn this off here for some reason, need to check later

import { bootLog } from './helpers/boot-log';
import { ensureServerDirs } from './helpers/ensure-server-dirs';

bootLog('server directories: ensuring');
await ensureServerDirs();
bootLog('server directories: ready');

// ----------------------------------------
import { loadEmbeds } from './utils/embeds';

bootLog('embedded assets: loading');
await loadEmbeds();
bootLog('embedded assets: loaded');

// ----------------------------------------
import { initSentry } from './sentry';
// ----------------------------------------
import { IS_PRODUCTION, SERVER_VERSION } from './utils/env';

bootLog('sentry: initializing');
initSentry();
bootLog('sentry: initialized');

// ----------------------------------------
import { ActivityLogType } from '@sharkord/shared';
import chalk from 'chalk';
import { config, SERVER_PRIVATE_IPS } from './config';
import { loadCrons } from './crons';
import { loadDb } from './db';
import { formatHostForUrl, resolvePreferredAddress } from './helpers/ip-addresses';
import { pluginManager } from './plugins';
import { enqueueActivityLog } from './queues/activity-log';
import { initVoiceRuntimes } from './runtimes';
import { createServers } from './utils/create-servers';
import { fileManager } from './utils/file-manager';
import { registerGracefulShutdown } from './utils/graceful-shutdown';
import { loadMediasoup } from './utils/mediasoup';
import { printDebug } from './utils/print-debug';
import './utils/updater';

// Arm termination handling before the boot steps so a SIGTERM/SIGINT during
// startup still flushes telemetry and exits cleanly. Resources (servers, worker,
// db) are registered once they exist; a signal received before then skips the
// (absent) drain steps.
registerGracefulShutdown();

const getBootErrorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === 'string') {
		return error;
	}

	return 'Unknown error';
};

const runBootStep = async (name: string, step: () => Promise<void> | void): Promise<void> => {
	bootLog(`${name}: starting`);

	try {
		await step();
	} catch (error) {
		bootLog(`${name}: failed: ${getBootErrorMessage(error)}`);
		throw error;
	}

	bootLog(`${name}: complete`);
};

await runBootStep('database', loadDb);
await runBootStep('plugins', pluginManager.loadPlugins);
await runBootStep('file manager', fileManager.initialize);
await runBootStep('mediasoup', loadMediasoup);
await runBootStep('voice runtimes', initVoiceRuntimes);
await runBootStep('servers', createServers);
await runBootStep('crons', loadCrons);

const host = IS_PRODUCTION
	? resolvePreferredAddress(SERVER_PRIVATE_IPS, config.webRtc.preferredFamily) || 'localhost'
	: 'localhost';
const url = `http://${formatHostForUrl(host)}:${config.server.port}/`;

const message = [
	`${chalk.green.bold('SHARKORD')} ${chalk.white.bold(`v${SERVER_VERSION}`)}`,
	chalk.dim('────────────────────────────────────────────────────'),
	`${chalk.yellow('Port:')} ${chalk.bold(String(config.server.port))}`,
	`${chalk.yellow('Interface:')} ${chalk.underline.cyan(url)}`,
].join('\n');

console.log('%s', message);

printDebug();

bootLog('server: ready');

enqueueActivityLog({
	type: ActivityLogType.SERVER_STARTED,
});
