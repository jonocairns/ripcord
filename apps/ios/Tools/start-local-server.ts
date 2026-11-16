import fs from 'node:fs/promises';
import path from 'node:path';

// A separate, persistent development database; never use the desktop/server data folder.
const root = path.resolve(import.meta.dirname, '../../..');
const runtime = path.join(root, '.amp/in/ios-server');
await fs.mkdir(path.join(runtime, 'data'), { recursive: true });
try {
	await fs.symlink(path.join(root, 'apps/server/src'), path.join(runtime, 'src'), 'dir');
} catch (error) {
	if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
}
process.chdir(runtime);
process.env.SHARKORD_PORT = process.env.PORT || '4993';
process.env.SHARKORD_WEBRTC_PORT = '40003';
process.env.SHARKORD_WEBRTC_IPV4_BIND_ADDRESS = '127.0.0.1';
process.env.SHARKORD_WEBRTC_IPV4_ANNOUNCED_ADDRESS = '127.0.0.1';
process.env.SHARKORD_WEBRTC_IPV6_ENABLED = 'false';
process.env.SHARKORD_DEBUG = 'true';
process.env.RIPCORD_CLIENT_ERROR_REPORTING_SENTRY_DSN = '';
process.env.RIPCORD_SERVER_ERROR_REPORTING_SENTRY_DSN = '';
await import('../../server/src/index');
// Native lifecycle tests perform more logins than a human. Rate limiting has
// its own backend tests; keep those budgets out of this isolated fixture.
const { clearRateLimitersForTests } = await import('../../server/src/utils/rate-limiters/rate-limiter');
setInterval(clearRateLimitersForTests, 100);
