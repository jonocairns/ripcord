import { getDesktopBridge, isDesktopRuntime } from './desktop-bridge';

type TServerRuntimeSource = 'web' | 'desktop';

type TServerRuntimeConfig = {
	source: TServerRuntimeSource;
	serverUrl: string;
	serverHost: string;
	isConfigured: boolean;
	needsSetup: boolean;
};

const PRIVATE_IPV4_PATTERNS = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./];

const isPrivateIpv4 = (hostname: string): boolean => {
	if (PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(hostname))) {
		return true;
	}

	const matched = /^172\.(\d{1,3})\./.exec(hostname);

	if (matched) {
		const secondOctet = Number(matched[1]);

		return secondOctet >= 16 && secondOctet <= 31;
	}

	return false;
};

const isPrivateIpv6 = (hostname: string): boolean => {
	const unbracketed = hostname.replace(/^\[|\]$/g, '');

	return (
		unbracketed === '::1' ||
		unbracketed.startsWith('fc') ||
		unbracketed.startsWith('fd') ||
		// Link-local is fe80::/10 (fe80-febf). Anchored on ':' so e.g. fe8::1 (= 0fe8::1, global) doesn't match.
		/^fe[89ab][0-9a-f]:/.test(unbracketed)
	);
};

/**
 * Expects a `URL.hostname` value: no port, IPv6 without brackets or with them but never with a port.
 * A raw `host:port` string (e.g. "192.168.1.1:4991") would be misread as an IPv6 address.
 */
const isPrivateServerHostname = (hostname: string): boolean => {
	const lowercased = hostname.toLowerCase();

	if (lowercased === 'localhost' || lowercased.endsWith('.localhost') || lowercased.endsWith('.local')) {
		return true;
	}

	if (lowercased.startsWith('[') || lowercased.includes(':')) {
		return isPrivateIpv6(lowercased);
	}

	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lowercased)) {
		return isPrivateIpv4(lowercased);
	}

	// Single-label names (e.g. "myserver") are almost always LAN hosts.
	return !lowercased.includes('.');
};

const normalizeServerUrl = (serverUrl: string) => {
	const trimmed = serverUrl.trim();

	if (!trimmed) {
		throw new Error('Server URL is required.');
	}

	const hasExplicitProtocol = /^[a-z]+:\/\//i.test(trimmed);
	const withProtocol = hasExplicitProtocol ? trimmed : `https://${trimmed}`;
	const url = new URL(withProtocol);

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Only HTTP/HTTPS server URLs are supported.');
	}

	if (!hasExplicitProtocol && isPrivateServerHostname(url.hostname)) {
		url.protocol = 'http:';
	}

	url.pathname = '/';
	url.search = '';
	url.hash = '';

	return {
		url: url.toString().replace(/\/$/, ''),
		host: url.host,
	};
};

type TNormalizedServerUrl = ReturnType<typeof normalizeServerUrl>;

const HTTPS_PROBE_TIMEOUT_MS = 4000;

const isHttpsServerReachable = async (httpsServerUrl: string): Promise<boolean> => {
	try {
		// no-cors: we only need TLS reachability, not a readable response.
		await fetch(httpsServerUrl, {
			mode: 'no-cors',
			cache: 'no-store',
			signal: AbortSignal.timeout(HTTPS_PROBE_TIMEOUT_MS),
		});

		return true;
	} catch {
		return false;
	}
};

const upgradeServerUrlToHttps = async (normalized: TNormalizedServerUrl): Promise<TNormalizedServerUrl> => {
	const url = new URL(normalized.url);

	if (url.protocol !== 'http:' || isPrivateServerHostname(url.hostname)) {
		return normalized;
	}

	url.protocol = 'https:';

	const httpsUrl = url.toString().replace(/\/$/, '');

	if (await isHttpsServerReachable(httpsUrl)) {
		return {
			url: httpsUrl,
			host: url.host,
		};
	}

	return normalized;
};

const getDefaultWebRuntimeConfig = (): TServerRuntimeConfig => {
	if (import.meta.env.MODE === 'development') {
		return {
			source: 'web',
			serverUrl: 'http://localhost:4991',
			serverHost: 'localhost:4991',
			isConfigured: true,
			needsSetup: false,
		};
	}

	const location = window.location;
	const serverUrl = `${location.protocol}//${location.host}`;

	return {
		source: 'web',
		serverUrl,
		serverHost: location.host,
		isConfigured: true,
		needsSetup: false,
	};
};

let runtimeServerConfig: TServerRuntimeConfig = {
	source: 'web',
	serverUrl: 'http://localhost:4991',
	serverHost: 'localhost:4991',
	isConfigured: true,
	needsSetup: false,
};

const initializeRuntimeServerConfig = async () => {
	if (!isDesktopRuntime()) {
		runtimeServerConfig = getDefaultWebRuntimeConfig();
		return runtimeServerConfig;
	}

	const desktopBridge = getDesktopBridge();
	const persistedServerUrl = (await desktopBridge?.getServerUrl()) || '';

	if (!persistedServerUrl.trim()) {
		runtimeServerConfig = {
			source: 'desktop',
			serverUrl: '',
			serverHost: '',
			isConfigured: false,
			needsSetup: true,
		};
		return runtimeServerConfig;
	}

	const normalized = normalizeServerUrl(persistedServerUrl);
	const upgraded = await upgradeServerUrlToHttps(normalized);

	if (upgraded.url !== normalized.url) {
		try {
			await desktopBridge?.setServerUrl(upgraded.url);
		} catch {
			// Persisting the upgrade is best-effort; the in-memory config still uses https.
		}
	}

	runtimeServerConfig = {
		source: 'desktop',
		serverUrl: upgraded.url,
		serverHost: upgraded.host,
		isConfigured: true,
		needsSetup: false,
	};

	return runtimeServerConfig;
};

const getRuntimeServerConfig = () => {
	return runtimeServerConfig;
};

const isDesktopServerSetupRequired = () => {
	return runtimeServerConfig.source === 'desktop' && runtimeServerConfig.needsSetup;
};

const updateDesktopServerUrl = async (serverUrl: string) => {
	const desktopBridge = getDesktopBridge();

	if (!desktopBridge) {
		throw new Error('Desktop bridge is not available.');
	}

	const normalized = normalizeServerUrl(serverUrl);
	const upgraded = await upgradeServerUrlToHttps(normalized);

	await desktopBridge.setServerUrl(upgraded.url);

	runtimeServerConfig = {
		source: 'desktop',
		serverUrl: upgraded.url,
		serverHost: upgraded.host,
		isConfigured: true,
		needsSetup: false,
	};
};

export {
	getRuntimeServerConfig,
	initializeRuntimeServerConfig,
	isDesktopServerSetupRequired,
	isPrivateServerHostname,
	normalizeServerUrl,
	updateDesktopServerUrl,
};
