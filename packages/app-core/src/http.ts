import type { TServerInfo, TTempFile } from '@sharkord/shared';
import { UploadHeaders } from '@sharkord/shared';
import { getServerConfigAdapter, getStorageAdapter } from './adapters';

type TAuthResponse = {
	refreshToken: string;
	success: boolean;
	token: string;
};

type TRefreshResponse = {
	refreshToken: string;
	token: string;
};

type TUploadInput =
	| File
	| {
			body: Blob;
			name: string;
			size: number;
			type: string;
	  };

const getBaseUrl = () => getServerConfigAdapter().getServerUrl();

const isWebFile = (value: TUploadInput): value is File => typeof File === 'function' && value instanceof File;

const fetchServerInfo = async (): Promise<TServerInfo | undefined> => {
	try {
		const response = await fetch(`${getBaseUrl()}/info`);

		if (!response.ok) {
			return undefined;
		}

		return (await response.json()) as TServerInfo;
	} catch {
		return undefined;
	}
};

const loginWithPassword = async (payload: {
	identity: string;
	invite?: string;
	password: string;
}): Promise<TAuthResponse> => {
	const response = await fetch(`${getBaseUrl()}/login`, {
		body: JSON.stringify(payload),
		headers: {
			'Content-Type': 'application/json',
		},
		method: 'POST',
	});

	if (!response.ok) {
		const data = await response.json();
		const error = new Error('Authentication failed');

		Object.assign(error, { data });
		throw error;
	}

	return (await response.json()) as TAuthResponse;
};

const refreshAccessToken = async (): Promise<boolean> => {
	const storage = getStorageAdapter();
	const refreshToken = await storage.getRefreshToken();

	if (!refreshToken) {
		return false;
	}

	try {
		const response = await fetch(`${getBaseUrl()}/refresh`, {
			body: JSON.stringify({ refreshToken }),
			headers: {
				'Content-Type': 'application/json',
			},
			method: 'POST',
		});

		if (!response.ok) {
			if (response.status === 400 || response.status === 401) {
				await storage.clearAuthToken();
			}

			return false;
		}

		const data = (await response.json()) as TRefreshResponse;

		if (!data.token || !data.refreshToken) {
			await storage.clearAuthToken();
			return false;
		}

		await storage.setAuthTokens(data.token, data.refreshToken);
		return true;
	} catch {
		return false;
	}
};

const revokeRefreshToken = async (): Promise<void> => {
	const storage = getStorageAdapter();
	const refreshToken = await storage.getRefreshToken();

	if (!refreshToken) {
		return;
	}

	try {
		await fetch(`${getBaseUrl()}/logout`, {
			body: JSON.stringify({ refreshToken }),
			headers: {
				'Content-Type': 'application/json',
			},
			method: 'POST',
		});
	} catch {
		// best effort only
	}
};

const uploadFiles = async (files: TUploadInput[]): Promise<TTempFile[]> => {
	const storage = getStorageAdapter();
	const uploadedFiles: TTempFile[] = [];

	for (const file of files) {
		const normalizedFile = isWebFile(file)
			? {
					body: file,
					name: file.name,
					size: file.size,
					type: file.type,
				}
			: file;

		const requestUpload = async () => {
			const token = await storage.getAuthToken();

			return fetch(`${getBaseUrl()}/upload`, {
				body: normalizedFile.body,
				headers: {
					'Content-Type': 'application/octet-stream',
					[UploadHeaders.CONTENT_LENGTH]: normalizedFile.size.toString(),
					[UploadHeaders.ORIGINAL_NAME]: normalizedFile.name,
					[UploadHeaders.TOKEN]: token ?? '',
					[UploadHeaders.TYPE]: normalizedFile.type,
				},
				method: 'POST',
			});
		};

		let response = await requestUpload();

		if (response.status === 401 && (await refreshAccessToken())) {
			response = await requestUpload();
		}

		if (!response.ok) {
			throw new Error(`Upload failed with status ${response.status}`);
		}

		uploadedFiles.push((await response.json()) as TTempFile);
	}

	return uploadedFiles;
};

export { fetchServerInfo, loginWithPassword, refreshAccessToken, revokeRefreshToken, uploadFiles };
export type { TUploadInput };
