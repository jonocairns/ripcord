import { getRuntimeServerConfig } from '@/runtime/server-config';
import type { TFile } from '@sharkord/shared';

const getHostFromServer = () => {
  const runtimeConfig = getRuntimeServerConfig();

  if (runtimeConfig.serverHost) {
    return runtimeConfig.serverHost;
  }

  return import.meta.env.MODE === 'development'
    ? 'localhost:4991'
    : window.location.host;
};

const getUrlFromServer = () => {
  const runtimeConfig = getRuntimeServerConfig();

  if (runtimeConfig.serverUrl) {
    return runtimeConfig.serverUrl;
  }

  if (import.meta.env.MODE === 'development') {
    return 'http://localhost:4991';
  }

  return `${window.location.protocol}//${window.location.host}`;
};

const getFileUrl = (file: TFile | undefined | null) => {
  if (!file) return '';

  const url = getUrlFromServer();

  let baseUrl = `${url}/public/${file.name}`;

  if (file._accessToken) {
    baseUrl += `?accessToken=${file._accessToken}`;
  }

  return encodeURI(baseUrl);
};

export { getFileUrl, getHostFromServer, getUrlFromServer };
