import fs from 'node:fs/promises';
import path from 'node:path';

const runtimePath = path.resolve(import.meta.dirname, '.runtime');
const dataPath = path.join(runtimePath, 'data');
const serverSourcePath = path.resolve(import.meta.dirname, '../../server/src');

await fs.rm(runtimePath, { recursive: true, force: true });
await fs.mkdir(dataPath, { recursive: true });
await fs.symlink(serverSourcePath, path.join(runtimePath, 'src'), 'dir');
await fs.writeFile(
	path.join(dataPath, 'config.ini'),
	[
		'[rateLimiters.sendAndEditMessage]',
		'maxRequests=60',
		'windowMs=60000',
		'',
		'[rateLimiters.joinVoiceChannel]',
		'maxRequests=60',
		'windowMs=60000',
		'',
		'[rateLimiters.voiceActivity]',
		'maxRequests=300',
		'windowMs=60000',
		'',
		'[rateLimiters.joinServer]',
		'maxRequests=1000',
		'windowMs=60000',
		'',
	].join('\n'),
);
process.chdir(runtimePath);

process.env.SHARKORD_DEBUG = 'true';
process.env.RIPCORD_CLIENT_ERROR_REPORTING_SENTRY_DSN = '';
process.env.RIPCORD_SERVER_ERROR_REPORTING_SENTRY_DSN = '';

await import('../../server/src/index.ts');
