export enum ServerEvents {
  NEW_MESSAGE = "newMessage",
  MESSAGE_UPDATE = "messageUpdate",
  MESSAGE_DELETE = "messageDelete",
  MESSAGE_TYPING = "messageTyping",

  USER_JOIN = "userJoin",
  USER_LEAVE = "userLeave",

  CHANNEL_CREATE = "channelCreate",
  CHANNEL_UPDATE = "channelUpdate",
  CHANNEL_DELETE = "channelDelete",

  USER_JOIN_VOICE = "userJoinVoice",
  USER_LEAVE_VOICE = "userLeaveVoice",
  USER_VOICE_STATE_UPDATE = "userVoiceStateUpdate",

  VOICE_NEW_PRODUCER = "voiceNewProducer",
  VOICE_PRODUCER_CLOSED = "voiceProducerClosed",

  EMOJI_CREATE = "emojiCreate",
  EMOJI_UPDATE = "emojiUpdate",
  EMOJI_DELETE = "emojiDelete",

  ROLE_CREATE = "roleCreate",
  ROLE_UPDATE = "roleUpdate",
  ROLE_DELETE = "roleDelete",

  USER_CREATE = "userCreate",
  USER_UPDATE = "userUpdate",
  USER_DELETE = "userDelete",

  SERVER_SETTINGS_UPDATE = "serverSettingsUpdate",
}

export type TNewMessage = {
  content: string;
  channelId: number;
};
