import type { TJoinedMessage, TJoinedPublicUser, TVoiceUserState } from '@sharkord/shared';

export enum PinnedCardType {
	USER = 'user',
	SCREEN_SHARE = 'screen-share',
	EXTERNAL_STREAM = 'external-stream',
}

export type TPinnedCard = {
	id: string;
	type: PinnedCardType;
	userId: number;
};

export enum SoundType {
	MESSAGE_RECEIVED = 'message_received',
	MESSAGE_SENT = 'message_sent',
	SERVER_DISCONNECTED = 'server_disconnected',

	OWN_USER_LEFT_VOICE_CHANNEL = 'own_user_left_voice_channel',
	OWN_USER_JOINED_VOICE_CHANNEL = 'own_user_joined_voice_channel',
	OWN_USER_MUTED_MIC = 'own_user_muted_mic',
	OWN_USER_UNMUTED_MIC = 'own_user_unmuted_mic',
	OWN_USER_MUTED_SOUND = 'own_user_muted_sound',
	OWN_USER_UNMUTED_SOUND = 'own_user_unmuted_sound',
	OWN_USER_STARTED_WEBCAM = 'own_user_started_webcam',
	OWN_USER_STOPPED_WEBCAM = 'own_user_stopped_webcam',
	OWN_USER_STARTED_SCREENSHARE = 'own_user_started_screenshare',
	OWN_USER_STOPPED_SCREENSHARE = 'own_user_stopped_screenshare',

	REMOTE_USER_STARTED_STREAM = 'remote_user_started_stream',
	STREAM_WATCHER_JOINED = 'stream_watcher_joined',
	STREAM_WATCHER_LEFT = 'stream_watcher_left',
	REMOTE_USER_JOINED_VOICE_CHANNEL = 'remote_user_joined_voice_channel',
	REMOTE_USER_LEFT_VOICE_CHANNEL = 'remote_user_left_voice_channel',
}

export type TMessagesMap = {
	[channelId: number]: TJoinedMessage[];
};

export type TMessagesPagination = {
	cursor: number | null;
};

export type TDisconnectInfo = {
	code: number;
	reason: string;
	wasClean: boolean;
	time: Date;
};

export type TVoiceUser = TJoinedPublicUser & {
	state: TVoiceUserState;
};
