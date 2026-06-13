import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OnHeadersReceivedListenerDetails, Session } from 'electron';

const PACKAGED_RENDERER_CSP_HEADER = 'Content-Security-Policy';
const PACKAGED_RENDERER_FILE_URL_PATTERN = 'file://*';

const packagedRendererCspDirectives: Record<string, readonly string[]> = {
	'default-src': ["'self'"],
	'script-src': ["'self'", "'wasm-unsafe-eval'", 'blob:'],
	'style-src': ["'self'", "'unsafe-inline'"],
	'img-src': ["'self'", 'data:', 'blob:', 'http:', 'https:'],
	'font-src': ["'self'", 'data:'],
	'media-src': ["'self'", 'blob:', 'data:', 'http:', 'https:'],
	'worker-src': ["'self'", 'blob:'],
	'connect-src': ["'self'", 'https:', 'wss:', 'http:', 'ws:', 'data:', 'blob:'],
	'frame-src': ['https://www.youtube.com', 'https://www.youtube-nocookie.com'],
	'object-src': ["'none'"],
	'base-uri': ["'self'"],
	'form-action': ["'self'"],
};

type TResponseHeaders = NonNullable<OnHeadersReceivedListenerDetails['responseHeaders']>;

const PACKAGED_RENDERER_CSP = Object.entries(packagedRendererCspDirectives)
	.map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
	.join('; ');

const normalizePath = (filePath: string): string => path.resolve(filePath);

const isPathInsideDirectory = (filePath: string, directoryPath: string): boolean => {
	const relativePath = path.relative(normalizePath(directoryPath), normalizePath(filePath));

	return (
		Boolean(relativePath) &&
		relativePath !== '..' &&
		!relativePath.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relativePath)
	);
};

const isPackagedRendererFileUrl = (requestUrl: string, rendererDistPath: string): boolean => {
	let filePath: string;

	try {
		filePath = fileURLToPath(requestUrl);
	} catch {
		return false;
	}

	return (
		normalizePath(filePath) === normalizePath(rendererDistPath) || isPathInsideDirectory(filePath, rendererDistPath)
	);
};

const withPackagedRendererCspReportOnly = (headers: TResponseHeaders | undefined): TResponseHeaders => {
	return {
		...headers,
		[PACKAGED_RENDERER_CSP_HEADER]: [PACKAGED_RENDERER_CSP],
	};
};

const getDevRendererCspUrlPattern = (devRendererUrl: string): string => {
	return `${new URL(devRendererUrl).origin}/*`;
};

const isDocumentResource = (resourceType: OnHeadersReceivedListenerDetails['resourceType']): boolean => {
	return resourceType === 'mainFrame' || resourceType === 'subFrame';
};

// Mirrors the packaged-build CSP onto the Vite dev renderer so local dev
// surfaces the same violations prod users would hit.
const installDevRendererCspHandler = (targetSession: Session, devRendererUrl: string): void => {
	targetSession.webRequest.onHeadersReceived(
		{
			urls: [getDevRendererCspUrlPattern(devRendererUrl)],
		},
		(details, callback) => {
			if (!isDocumentResource(details.resourceType)) {
				callback({
					responseHeaders: details.responseHeaders,
				});
				return;
			}

			callback({
				responseHeaders: withPackagedRendererCspReportOnly(details.responseHeaders),
			});
		},
	);
};

const installPackagedRendererCspReportOnlyHandler = (targetSession: Session, rendererDistPath: string): void => {
	targetSession.webRequest.onHeadersReceived(
		{
			urls: [PACKAGED_RENDERER_FILE_URL_PATTERN],
		},
		(details, callback) => {
			if (!isPackagedRendererFileUrl(details.url, rendererDistPath)) {
				callback({
					responseHeaders: details.responseHeaders,
				});
				return;
			}

			callback({
				responseHeaders: withPackagedRendererCspReportOnly(details.responseHeaders),
			});
		},
	);
};

export {
	getDevRendererCspUrlPattern,
	installDevRendererCspHandler,
	installPackagedRendererCspReportOnlyHandler,
	isPackagedRendererFileUrl,
	PACKAGED_RENDERER_CSP,
	PACKAGED_RENDERER_CSP_HEADER,
	PACKAGED_RENDERER_FILE_URL_PATTERN,
	withPackagedRendererCspReportOnly,
};
