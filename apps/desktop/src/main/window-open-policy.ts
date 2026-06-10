type TWindowOpenPolicyResult =
	| {
			action: 'allow';
			openExternal: false;
	  }
	| {
			action: 'deny';
			openExternal: boolean;
	  };

const classifyWindowOpenUrl = (url: string): TWindowOpenPolicyResult => {
	if (url.startsWith('about:blank')) {
		return {
			action: 'allow',
			openExternal: false,
		};
	}

	try {
		const parsedUrl = new URL(url);
		const isHttp = parsedUrl.protocol === 'http:';
		const isHttps = parsedUrl.protocol === 'https:';

		if (isHttp || isHttps) {
			return {
				action: 'deny',
				openExternal: true,
			};
		}
	} catch {
		// fall through for malformed and unsupported urls
	}

	return {
		action: 'deny',
		openExternal: false,
	};
};

export type { TWindowOpenPolicyResult };
export { classifyWindowOpenUrl };
