import type { ChannelPermission, TFile, TSettings, TUser } from '.';

export enum ChannelType {
	TEXT = 'TEXT',
	VOICE = 'VOICE',
}

export enum StreamKind {
	AUDIO = 'audio',
	VIDEO = 'video',
	SCREEN = 'screen',
	SCREEN_AUDIO = 'screen_audio',
	EXTERNAL_VIDEO = 'external_video',
	EXTERNAL_AUDIO = 'external_audio',
}

export type TExternalStreamTrackKind = 'audio' | 'video';

export type TExternalStreamTracks = {
	audio?: boolean;
	video?: boolean;
};

export type TRemoteProducerRef = {
	remoteId: number;
	producerId: string;
};

export type TExternalProducerRef = {
	streamId: number;
	producerId: string;
};

export type TRemoteProducerIds = {
	/**
	 * @deprecated Use remoteVideoProducers instead. Kept for older clients.
	 */
	remoteVideoIds: number[];
	/**
	 * @deprecated Use remoteAudioProducers instead. Kept for older clients.
	 */
	remoteAudioIds: number[];
	/**
	 * @deprecated Use remoteScreenProducers instead. Kept for older clients.
	 */
	remoteScreenIds: number[];
	/**
	 * @deprecated Use remoteScreenAudioProducers instead. Kept for older clients.
	 */
	remoteScreenAudioIds: number[];
	/**
	 * @deprecated Use remoteExternalAudioProducers / remoteExternalVideoProducers
	 * and externalStreamTracks instead. Kept for older clients.
	 */
	remoteExternalStreamIds: number[];
	// Authoritative per-stream external track presence from the snapshot.
	// Optional for backward compatibility with older servers; when present the
	// client prefers it over (potentially stale) local channel metadata.
	externalStreamTracks?: { [streamId: number]: { audio: boolean; video: boolean } };
	remoteVideoProducers?: TRemoteProducerRef[];
	remoteAudioProducers?: TRemoteProducerRef[];
	remoteScreenProducers?: TRemoteProducerRef[];
	remoteScreenAudioProducers?: TRemoteProducerRef[];
	remoteExternalAudioProducers?: TExternalProducerRef[];
	remoteExternalVideoProducers?: TExternalProducerRef[];
};

export type TPublicServerSettings = Pick<
	TSettings,
	| 'name'
	| 'description'
	| 'serverId'
	| 'storageUploadEnabled'
	| 'storageQuota'
	| 'storageUploadMaxFileSize'
	| 'storageSpaceQuotaByUser'
	| 'storageOverflowAction'
	| 'enablePlugins'
>;

export type TGenericObject = {
	[key: string]: any;
};

export type TGenericFunction = (...args: any[]) => any;

export type TMessageMetadata = {
	url: string;
	title?: string;
	siteName?: string;
	description?: string;
	mediaType: string;
	images?: string[];
	videos?: string[];
	favicons?: string[];
};

export type WithOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export enum UserStatus {
	ONLINE = 'online',
	AWAY = 'away',
	IDLE = 'idle',
	OFFLINE = 'offline',
}

export type TUserPresenceStatus = 'online' | 'away';

export type TOwnUser = WithOptional<TUser, 'identity'>;

export type TConnectionParams = {
	token: string;
	clientInstanceId?: string;
};

export type TTempFile = {
	id: string;
	originalName: string;
	size: number;
	md5: string;
	path: string;
	extension: string;
	userId: number;
};

export type TServerInfo = Pick<TSettings, 'serverId' | 'name' | 'description' | 'allowNewUsers'> & {
	logo: TFile | null;
	version: string;
	clientErrorReporting?: {
		provider: 'sentry';
		dsn: string;
		ignoreErrors?: string[];
		tracingSampleRate?: number;
		replaySessionSampleRate?: number;
		replayOnErrorSampleRate?: number;
	};
};

export type TArtifact = {
	name: string;
	target: string;
	size: number;
	checksum: string;
};

export type TVersionInfo = {
	version: string;
	releaseDate: string;
	artifacts: TArtifact[];
};

export type TIpInfo = {
	ip: string;
	hostname: string;
	city: string;
	region: string;
	country: string;
	loc: string;
	org: string;
	postal: string;
	timezone: string;
};

export type TChannelPermissionsMap = Record<ChannelPermission, boolean>;

export type TChannelUserPermissionsMap = Record<number, { channelId: number; permissions: TChannelPermissionsMap }>;

export type TReadStateMap = Record<number, number>;
