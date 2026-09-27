import { config } from '../config';
import type { TClientIpOptions } from './get-ws-info';

let clientIpOptionsOverride: TClientIpOptions | undefined;

const getClientIpOptions = (): TClientIpOptions =>
	clientIpOptionsOverride ?? {
		trustProxy: config.server.trustProxy,
		trustedProxies: config.server.trustedProxies,
		clientIpHeader: config.server.clientIpHeader,
	};

// The config is frozen and HTTP tests always connect from loopback, so tests
// swap the proxy settings here to exercise trusted and untrusted peers.
const setClientIpOptionsForTests = (options: TClientIpOptions | undefined) => {
	clientIpOptionsOverride = options;
};

export { getClientIpOptions, setClientIpOptionsForTests };
