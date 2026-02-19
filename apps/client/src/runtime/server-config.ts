import { getDesktopBridge, isDesktopRuntime } from './desktop-bridge';

type TServerRuntimeSource = 'web' | 'desktop';

type TServerRuntimeConfig = {
  source: TServerRuntimeSource;
  serverUrl: string;
  serverHost: string;
  isConfigured: boolean;
  needsSetup: boolean;
};

const normalizeServerUrl = (serverUrl: string) => {
  const trimmed = serverUrl.trim();

  if (!trimmed) {
    throw new Error('Server URL is required.');
  }

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  const url = new URL(withProtocol);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP/HTTPS server URLs are supported.');
  }

  url.pathname = '/';
  url.search = '';
  url.hash = '';

  return {
    url: url.toString().replace(/\/$/, ''),
    host: url.host
  };
};

const getDefaultWebRuntimeConfig = (): TServerRuntimeConfig => {
  if (import.meta.env.MODE === 'development') {
    return {
      source: 'web',
      serverUrl: 'http://localhost:4991',
      serverHost: 'localhost:4991',
      isConfigured: true,
      needsSetup: false
    };
  }

  const location = window.location;
  const serverUrl = `${location.protocol}//${location.host}`;

  return {
    source: 'web',
    serverUrl,
    serverHost: location.host,
    isConfigured: true,
    needsSetup: false
  };
};

let runtimeServerConfig: TServerRuntimeConfig = {
  source: 'web',
  serverUrl: 'http://localhost:4991',
  serverHost: 'localhost:4991',
  isConfigured: true,
  needsSetup: false
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
      needsSetup: true
    };
    return runtimeServerConfig;
  }

  const normalized = normalizeServerUrl(persistedServerUrl);

  runtimeServerConfig = {
    source: 'desktop',
    serverUrl: normalized.url,
    serverHost: normalized.host,
    isConfigured: true,
    needsSetup: false
  };

  return runtimeServerConfig;
};

const getRuntimeServerConfig = () => {
  return runtimeServerConfig;
};

const isDesktopServerSetupRequired = () => {
  return (
    runtimeServerConfig.source === 'desktop' && runtimeServerConfig.needsSetup
  );
};

const updateDesktopServerUrl = async (serverUrl: string) => {
  const desktopBridge = getDesktopBridge();

  if (!desktopBridge) {
    throw new Error('Desktop bridge is not available.');
  }

  const normalized = normalizeServerUrl(serverUrl);

  await desktopBridge.setServerUrl(normalized.url);

  runtimeServerConfig = {
    source: 'desktop',
    serverUrl: normalized.url,
    serverHost: normalized.host,
    isConfigured: true,
    needsSetup: false
  };
};

export {
  getRuntimeServerConfig,
  initializeRuntimeServerConfig,
  isDesktopServerSetupRequired,
  normalizeServerUrl,
  updateDesktopServerUrl
};
