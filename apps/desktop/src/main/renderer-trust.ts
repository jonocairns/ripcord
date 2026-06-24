import path from 'node:path';
import { fileURLToPath } from 'node:url';

type TRendererTrustOptions = {
	packagedIndexPath: string;
	rendererUrl?: string;
};

type TResolveTrustedRendererUrlOptions = {
	isPackaged: boolean;
	isPreview: boolean;
	rendererUrl?: string;
};

const isExternalBrowserProtocol = (protocol: string): boolean => {
	return protocol === 'http:' || protocol === 'https:';
};

const isLocalDevHostname = (hostname: string): boolean => {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
};

const normalizeFilePath = (filePath: string): string => {
	return path.resolve(filePath);
};

const getTrustedDevOrigin = (rendererUrl?: string): string | undefined => {
	if (!rendererUrl) {
		return undefined;
	}

	try {
		const parsedRendererUrl = new URL(rendererUrl);

		if (!isExternalBrowserProtocol(parsedRendererUrl.protocol)) {
			return undefined;
		}

		if (!isLocalDevHostname(parsedRendererUrl.hostname)) {
			return undefined;
		}

		return parsedRendererUrl.origin;
	} catch {
		return undefined;
	}
};

const resolveTrustedRendererUrl = ({
	isPackaged,
	isPreview,
	rendererUrl,
}: TResolveTrustedRendererUrlOptions): string | undefined => {
	if (isPackaged && !isPreview) {
		return undefined;
	}

	return getTrustedDevOrigin(rendererUrl) ? rendererUrl : undefined;
};

const isTrustedRendererUrl = (rendererUrl: string, options: TRendererTrustOptions): boolean => {
	try {
		const parsedUrl = new URL(rendererUrl);
		const trustedDevOrigin = getTrustedDevOrigin(options.rendererUrl);

		if (trustedDevOrigin && isExternalBrowserProtocol(parsedUrl.protocol) && parsedUrl.origin === trustedDevOrigin) {
			return true;
		}

		if (parsedUrl.protocol === 'file:' && !trustedDevOrigin) {
			const candidatePath = normalizeFilePath(fileURLToPath(parsedUrl));
			const packagedIndexPath = normalizeFilePath(options.packagedIndexPath);

			return candidatePath === packagedIndexPath;
		}

		return false;
	} catch {
		return false;
	}
};

export type { TRendererTrustOptions, TResolveTrustedRendererUrlOptions };
export { isExternalBrowserProtocol, isTrustedRendererUrl, resolveTrustedRendererUrl };
