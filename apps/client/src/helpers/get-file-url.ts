import type { TFile } from '@sharkord/shared';
import { getRuntimeServerConfig } from '@/runtime/server-config';

const getHostFromServer = () => {
	const runtimeConfig = getRuntimeServerConfig();

	if (runtimeConfig.serverHost) {
		return runtimeConfig.serverHost;
	}

	return import.meta.env.MODE === 'development' ? 'localhost:4991' : window.location.host;
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

	let baseUrl = `${url}/public/${encodeURIComponent(file.name)}`;

	const params = new URLSearchParams();

	if (file._accessToken) {
		params.set('accessToken', file._accessToken);
	}

	// Cache-bust: file.id changes on each upload even if the filename is reused
	params.set('v', String(file.id));

	baseUrl += `?${params.toString()}`;

	return baseUrl;
};

type TPublicAssetUrlOptions = {
	absolute?: boolean;
};

const getPublicAssetUrl = (assetPath: string, options: TPublicAssetUrlOptions = {}) => {
	const normalizedAssetPath = assetPath.replace(/^\/+/, '');
	const assetUrl = window.location.protocol === 'file:' ? `./${normalizedAssetPath}` : `/${normalizedAssetPath}`;

	if (options.absolute) {
		return new URL(assetUrl, window.location.href).toString();
	}

	return assetUrl;
};

export { getFileUrl, getHostFromServer, getPublicAssetUrl, getUrlFromServer };
