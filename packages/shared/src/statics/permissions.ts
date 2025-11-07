export enum Permission {
  SEND_MESSAGES = "SEND_MESSAGES",
  REACT_TO_MESSAGES = "REACT_TO_MESSAGES",
  UPLOAD_FILES = "UPLOAD_FILES",
  JOIN_VOICE_CHANNELS = "JOIN_VOICE_CHANNELS",
  SHARE_SCREEN = "SHARE_SCREEN",
  ENABLE_WEBCAM = "ENABLE_WEBCAM",
  // ADMIN PERMISSIONS
  MANAGE_CHANNELS = "MANAGE_CHANNELS",
  MANAGE_CATEGORIES = "MANAGE_CATEGORIES",
  MANAGE_ROLES = "MANAGE_ROLES",
  MANAGE_EMOJIS = "MANAGE_EMOJIS",
  MANAGE_NOTIFICATION_SOUNDS = "MANAGE_NOTIFICATION_SOUNDS",
  MANAGE_SERVER = "MANAGE_SERVER",
  MANAGE_USERS = "MANAGE_USERS",
  MANAGE_FILES = "MANAGE_FILES",
  MANAGE_MESSAGES = "MANAGE_MESSAGES",
  MANAGE_STORAGE = "MANAGE_STORAGE",
  MANAGE_INVITES = "MANAGE_INVITES",
  VIEW_AUDIT_LOG = "VIEW_AUDIT_LOG",
  VIEW_SERVER_STATS = "VIEW_SERVER_STATS",
}

export const permissionLabels: Record<Permission, string> = {
  [Permission.SEND_MESSAGES]: "Send messages",
  [Permission.REACT_TO_MESSAGES]: "React to messages",
  [Permission.UPLOAD_FILES]: "Upload files",
  [Permission.JOIN_VOICE_CHANNELS]: "Join voice channels",
  [Permission.SHARE_SCREEN]: "Share screen",
  [Permission.ENABLE_WEBCAM]: "Enable webcam",
  [Permission.MANAGE_CHANNELS]: "Manage channels",
  [Permission.MANAGE_CATEGORIES]: "Manage categories",
  [Permission.MANAGE_ROLES]: "Manage roles",
  [Permission.MANAGE_EMOJIS]: "Manage emojis",
  [Permission.MANAGE_NOTIFICATION_SOUNDS]: "Manage sounds",
  [Permission.MANAGE_SERVER]: "Manage server",
  [Permission.MANAGE_USERS]: "Manage users",
  [Permission.MANAGE_FILES]: "Manage files",
  [Permission.MANAGE_MESSAGES]: "Manage messages",
  [Permission.MANAGE_STORAGE]: "Manage storage",
  [Permission.MANAGE_INVITES]: "Manage invites",
  [Permission.VIEW_AUDIT_LOG]: "View audit log",
  [Permission.VIEW_SERVER_STATS]: "View server stats",
};

export const permissionDescriptions: Record<Permission, string> = {
  [Permission.SEND_MESSAGES]:
    "Grants the ability to send messages in channels.",
  [Permission.REACT_TO_MESSAGES]: "Grants the ability to react to messages.",
  [Permission.UPLOAD_FILES]: "Grants the ability to upload files in channels.",
  [Permission.JOIN_VOICE_CHANNELS]:
    "Grants the ability to join voice channels.",
  [Permission.SHARE_SCREEN]: "Grants the ability to share the screen.",
  [Permission.ENABLE_WEBCAM]: "Grants the ability to enable the webcam.",
  [Permission.MANAGE_CHANNELS]:
    "Grants the ability to create, update, and delete channels.",
  [Permission.MANAGE_CATEGORIES]:
    "Grants the ability to create, update, and delete categories.",
  [Permission.MANAGE_ROLES]:
    "Grants the ability to create, update, and delete roles.",
  [Permission.MANAGE_EMOJIS]:
    "Grants the ability to create, update, and delete emojis.",
  [Permission.MANAGE_NOTIFICATION_SOUNDS]:
    "Grants the ability to manage sounds.",
  [Permission.MANAGE_SERVER]: "Grants the ability to manage the server.",
  [Permission.MANAGE_USERS]: "Grants the ability to manage users.",
  [Permission.MANAGE_FILES]: "Grants the ability to manage files.",
  [Permission.MANAGE_MESSAGES]:
    "Grants the ability to manage messages from all users by editing or deleting them.",
  [Permission.MANAGE_STORAGE]:
    "Grants the ability to manage storage, such as enabling or disabling uploads.",
  [Permission.MANAGE_INVITES]:
    "Grants the ability to create, edit, and delete server invites.",
  [Permission.VIEW_AUDIT_LOG]: "Grants the ability to view the audit log.",
  [Permission.VIEW_SERVER_STATS]:
    "Grants the ability to view server stats, such as CPU and RAM usage.",
};

export const DEFAULT_ROLE_PERMISSIONS = [
  Permission.JOIN_VOICE_CHANNELS,
  Permission.SEND_MESSAGES,
  Permission.UPLOAD_FILES,
  Permission.SHARE_SCREEN,
  Permission.ENABLE_WEBCAM,
];

export enum UploadHeaders {
  ORIGINAL_NAME = "x-file-name",
  TYPE = "x-file-type",
  CONTENT_LENGTH = "content-length",
  TOKEN = "x-token",
}
