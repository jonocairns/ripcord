import type { TCommandInfo, TCommandsMapByPlugin, TServerInfo, TTempFile } from '@sharkord/shared';

export interface StorageAdapter {
	clearAuthToken(): void | Promise<void>;
	getAuthToken(): string | null | Promise<string | null>;
	getRefreshToken(): string | null | Promise<string | null>;
	setAuthTokens(token: string, refreshToken: string): void | Promise<void>;
}

export interface ServerConfigAdapter {
	getServerHost(): string;
	getServerProtocol(): string;
	getServerUrl(): string;
}

export interface UploadAdapter {
	uploadFiles(files: File[]): Promise<TTempFile[]>;
}

export interface SessionEffects {
	onMessageReceived?(payload: { channelId: number; messageId: number; isOwnMessage: boolean }): void;
	onPasswordRequired?(payload: { handshakeHash: string; serverId: string }): void;
	onPluginCommandsChanged?(commands: TCommandsMapByPlugin): void;
	onReset?(): void;
	onServerDisconnected?(): void;
	onServerInfoLoaded?(info: TServerInfo | undefined): void;
	onCommandReceived?(command: TCommandInfo): void;
}

type RuntimeAdapters = {
	effects?: SessionEffects;
	serverConfig?: ServerConfigAdapter;
	storage?: StorageAdapter;
	upload?: UploadAdapter;
};

const runtimeAdapters: RuntimeAdapters = {};

const configureAppCore = (next: RuntimeAdapters) => {
	if (next.effects) {
		runtimeAdapters.effects = next.effects;
	}

	if (next.serverConfig) {
		runtimeAdapters.serverConfig = next.serverConfig;
	}

	if (next.storage) {
		runtimeAdapters.storage = next.storage;
	}

	if (next.upload) {
		runtimeAdapters.upload = next.upload;
	}
};

const getEffects = () => runtimeAdapters.effects;

const getServerConfigAdapter = (): ServerConfigAdapter => {
	if (!runtimeAdapters.serverConfig) {
		throw new Error('App core server config adapter is not configured');
	}

	return runtimeAdapters.serverConfig;
};

const getStorageAdapter = (): StorageAdapter => {
	if (!runtimeAdapters.storage) {
		throw new Error('App core storage adapter is not configured');
	}

	return runtimeAdapters.storage;
};

const getUploadAdapter = (): UploadAdapter => {
	if (!runtimeAdapters.upload) {
		throw new Error('App core upload adapter is not configured');
	}

	return runtimeAdapters.upload;
};

export { configureAppCore, getEffects, getServerConfigAdapter, getStorageAdapter, getUploadAdapter };
