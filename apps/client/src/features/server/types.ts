import {
  type TJoinedMessage,
  type TJoinedPublicUser,
  type TVoiceUserState
} from '@sharkord/shared';

export enum NotificationSoundType {
  USER_JOINED_SERVER = 'user_joined_server',
  USER_LEFT_SERVER = 'user_left_server',
  USER_JOINED_VOICE_CHANNEL = 'user_joined_voice_channel',
  USER_LEFT_VOICE_CHANNEL = 'user_left_voice_channel',
  MESSAGE_RECEIVED = 'message_received',
  MESSAGE_SENT = 'message_sent',
  CHANNEL_CREATED = 'channel_created',
  CHANNEL_EDITED = 'channel_edited',
  CHANNEL_DELETED = 'channel_deleted',
  OWN_USER_JOINED_SERVER = 'own_user_joined_server',
  OWN_USER_LEFT_SERVER = 'own_user_left_server',
  OWN_USER_MUTED_MIC = 'own_user_muted_mic',
  OWN_USER_UNMUTED_MIC = 'own_user_unmuted_mic',
  OWN_USER_MUTED_SOUND = 'own_user_muted_sound',
  OWN_USER_UNMUTED_SOUND = 'own_user_unmuted_sound',
  OWN_USER_STARTED_WEBCAM = 'own_user_started_webcam',
  OWN_USER_STOPPED_WEBCAM = 'own_user_stopped_webcam',
  OWN_USER_STARTED_SCREENSHARE = 'own_user_started_screenshare',
  OWN_USER_STOPPED_SCREENSHARE = 'own_user_stopped_screenshare',
  OWN_USER_JOINED_VOICE_CHANNEL = 'own_user_joined_voice_channel',
  OWN_USER_LEFT_VOICE_CHANNEL = 'own_user_left_voice_channel',
  OWN_USER_KICKED_FROM_SERVER = 'own_user_kicked_from_server',
  OWN_USER_KICKED_FROM_CHANNEL = 'own_user_kicked_from_channel',
  OWN_USER_BANNED_FROM_SERVER = 'own_user_banned_from_server',
  OWN_USER_OTHER_USER_KICKED_FROM_SERVER = 'own_user_other_user_kicked_from_server',
  OWN_USER_OTHER_USER_KICKED_FROM_CHANNEL = 'own_user_other_user_kicked_from_channel',
  OWN_USER_OTHER_USER_BANNED_FROM_SERVER = 'own_user_other_user_banned_from_server'
}

export type TMessagesMap = {
  [channelId: number]: TJoinedMessage[];
};

export type TMessagesPagination = {
  cursor: number | null;
};

export type TChannelPaginationMap = {
  [channelId: number]: TMessagesPagination;
};

export type TPreloadedNotificationSoundsMap = {
  [soundType in NotificationSoundType]?: HTMLAudioElement;
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
