import type { OnBeforeSendHeadersListenerDetails, Session } from 'electron';

const DESKTOP_YOUTUBE_EMBED_REFERRER = 'https://ripcord.com/';

const YOUTUBE_EMBED_REQUEST_URL_PATTERNS = [
	'*://youtube.com/*',
	'*://*.youtube.com/*',
	'*://youtube-nocookie.com/*',
	'*://*.youtube-nocookie.com/*',
];

type TRequestHeaders = OnBeforeSendHeadersListenerDetails['requestHeaders'];

const getRequestHeaderValue = (headers: TRequestHeaders, name: string): string | undefined => {
	const normalizedName = name.toLowerCase();

	for (const [headerName, headerValue] of Object.entries(headers)) {
		if (headerName.toLowerCase() !== normalizedName) {
			continue;
		}

		if (typeof headerValue === 'string') {
			return headerValue;
		}

		return headerValue[0];
	}

	return undefined;
};

const stripRequestHeader = (headers: TRequestHeaders, name: string): TRequestHeaders => {
	const normalizedName = name.toLowerCase();
	const nextHeaders: TRequestHeaders = {};

	for (const [headerName, headerValue] of Object.entries(headers)) {
		if (headerName.toLowerCase() === normalizedName) {
			continue;
		}

		nextHeaders[headerName] = headerValue;
	}

	return nextHeaders;
};

const ensureYoutubeEmbedRefererHeader = (headers: TRequestHeaders): TRequestHeaders => {
	const existingReferer = getRequestHeaderValue(headers, 'referer');

	if (existingReferer && existingReferer.trim().length > 0) {
		return headers;
	}

	const headersWithoutReferer = stripRequestHeader(headers, 'referer');

	return {
		...headersWithoutReferer,
		Referer: DESKTOP_YOUTUBE_EMBED_REFERRER,
	};
};

const installYoutubeEmbedRefererHandler = (targetSession: Session): void => {
	targetSession.webRequest.onBeforeSendHeaders(
		{
			urls: YOUTUBE_EMBED_REQUEST_URL_PATTERNS,
		},
		(details, callback) => {
			callback({
				requestHeaders: ensureYoutubeEmbedRefererHeader(details.requestHeaders),
			});
		},
	);
};

export {
	DESKTOP_YOUTUBE_EMBED_REFERRER,
	ensureYoutubeEmbedRefererHeader,
	installYoutubeEmbedRefererHandler,
	YOUTUBE_EMBED_REQUEST_URL_PATTERNS,
};
