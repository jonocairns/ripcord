import {
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MIN_QUOTA_PER_USER,
  STORAGE_QUOTA,
  StorageOverflowAction,
  type TMessageMetadata
} from '@sharkord/shared';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core';

const settings = sqliteTable(
  'settings',
  {
    name: text('name').notNull(),
    description: text('description'),
    password: text('password'),
    serverId: text('server_id').notNull(),
    secretToken: text('secret_token'),
    logoId: integer('logoId').references(() => files.id),
    allowNewUsers: integer('allowNewUsers', { mode: 'boolean' })
      .notNull()
      .default(true),
    storageUploadEnabled: integer('storageUploadsEnabled', { mode: 'boolean' })
      .notNull()
      .default(true),
    storageQuota: integer('storageQuota').notNull().default(STORAGE_QUOTA),
    storageUploadMaxFileSize: integer('storageUploadMaxFileSize')
      .notNull()
      .default(STORAGE_MAX_FILE_SIZE),
    storageSpaceQuotaByUser: integer('storageSpaceQuotaByUser')
      .notNull()
      .default(STORAGE_MIN_QUOTA_PER_USER),
    storageOverflowAction: text('storageOverflowAction')
      .notNull()
      .default(StorageOverflowAction.PREVENT_UPLOADS)
  },
  (t) => ({
    serverIdx: index('settings_server_idx').on(t.serverId)
  })
);

const roles = sqliteTable('roles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#ffffff'),
  isPersistent: integer('isPersistent', { mode: 'boolean' }).notNull(),
  isDefault: integer('isDefault', { mode: 'boolean' }).notNull(),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt')
});

const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    createdAt: integer('createdAt').notNull(),
    updatedAt: integer('updatedAt')
  },
  (t) => ({
    posIdx: index('categories_position_idx').on(t.position)
  })
);

const channels = sqliteTable(
  'channels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    name: text('name').notNull(),
    topic: text('topic'),
    password: text('password'),
    position: integer('position').notNull(),
    categoryId: integer('categoryId').references(() => categories.id),
    createdAt: integer('createdAt').notNull(),
    updatedAt: integer('updatedAt')
  },
  (t) => ({
    catIdx: index('channels_category_idx').on(t.categoryId),
    posIdx: index('channels_position_idx').on(t.position)
  })
);

const files = sqliteTable(
  'files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    originalName: text('originalName').notNull(),
    md5: text('md5').notNull(),
    userId: integer('userId').notNull(),
    size: integer('size').notNull(),
    mimeType: text('mimeType').notNull(),
    extension: text('extension').notNull(),
    createdAt: integer('createdAt').notNull(),
    updatedAt: integer('updatedAt')
  },
  (t) => ({
    userIdx: index('files_user_idx').on(t.userId)
  })
);

const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    identity: text('identity').unique().notNull(),
    password: text('password').notNull(),
    name: text('name').notNull(),
    avatarId: integer('avatarId').references(() => files.id),
    bannerId: integer('bannerId').references(() => files.id),
    roleId: integer('roleId')
      .notNull()
      .references(() => roles.id),
    bio: text('bio'),
    banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
    banReason: text('banReason'),
    bannedAt: integer('bannedAt'),
    bannerColor: text('bannerColor'),
    lastLoginAt: integer('lastLoginAt')
      .notNull()
      .$defaultFn(() => Date.now()),
    createdAt: integer('createdAt').notNull(),
    updatedAt: integer('updatedAt')
  },
  (t) => ({
    identityIdx: uniqueIndex('users_identity_idx').on(t.identity),
    roleIdx: index('users_role_idx').on(t.roleId)
  })
);

const logins = sqliteTable(
  'logins',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('userId')
      .notNull()
      .references(() => users.id),
    userAgent: text('userAgent'),
    os: text('os'),
    device: text('device'),
    ip: text('ip'),
    hostname: text('hostname'),
    city: text('city'),
    region: text('region'),
    country: text('country'),
    loc: text('loc'),
    org: text('org'),
    postal: text('postal'),
    timezone: text('timezone'),
    createdAt: integer('createdAt').notNull(),
    updatedAt: integer('updatedAt')
  },
  (t) => ({
    userIdx: index('logins_user_idx').on(t.userId),
    ipIdx: index('logins_ip_idx').on(t.ip)
  })
);

const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    content: text('content'),
    userId: integer('userId')
      .notNull()
      .references(() => users.id),
    channelId: integer('channelId')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    metadata: text('metadata', { mode: 'json' }).$type<TMessageMetadata[]>(),
    createdAt: integer('createdAt').notNull(),
    updatedAt: integer('updatedAt')
  },
  (t) => ({
    userIdx: index('messages_user_idx').on(t.userId),
    channelIdx: index('messages_channel_idx').on(t.channelId),
    createdIdx: index('messages_created_idx').on(t.createdAt)
  })
);

const messageFiles = sqliteTable(
  'message_files',
  {
    messageId: integer('messageId')
      .notNull()
      .references(() => messages.id),
    fileId: integer('fileId')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    createdAt: integer('createdAt').notNull(),
    updatedAt: integer('updatedAt')
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.fileId] }),
    msgIdx: index('message_files_msg_idx').on(t.messageId),
    fileIdx: index('message_files_file_idx').on(t.fileId)
  })
);

const rolePermissions = sqliteTable(
  'role_permissions',
  {
    roleId: integer('roleId')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    createdAt: integer('createdAt').notNull(),
    updatedAt: integer('updatedAt')
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.permission] }),
    roleIdx: index('role_permissions_role_idx').on(t.roleId)
  })
);

const emojis = sqliteTable(
  'emojis',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    fileId: integer('fileId')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    userId: integer('userId')
      .notNull()
      .references(() => users.id),
    createdAt: integer('createdAt').notNull(),
    updatedAt: integer('updatedAt')
  },
  (t) => ({
    userIdx: index('emojis_user_idx').on(t.userId),
    fileIdx: index('emojis_file_idx').on(t.fileId),
    nameIdx: uniqueIndex('emojis_name_idx').on(t.name)
  })
);

const notificationSounds = sqliteTable(
  'notification_sounds',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull().unique(),
    fileId: integer('fileId')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    userId: integer('userId')
      .notNull()
      .references(() => users.id),
    volume: integer('volume').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    createdAt: integer('createdAt').notNull(),
    updatedAt: integer('updatedAt')
  },
  (t) => ({
    typeIdx: uniqueIndex('notification_sounds_type_idx').on(t.type),
    userIdx: index('notification_sounds_user_idx').on(t.userId)
  })
);

const messageReactions = sqliteTable(
  'message_reactions',
  {
    messageId: integer('messageId')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: integer('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    fileId: integer('fileId').references(() => files.id),
    createdAt: integer('createdAt').notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    msgIdx: index('reaction_msg_idx').on(t.messageId),
    emojix: index('reaction_emoji_idx').on(t.emoji),
    userIdx: index('reaction_user_idx').on(t.userId)
  })
);

const invites = sqliteTable(
  'invites',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code').notNull().unique(),
    creatorId: integer('creatorId')
      .notNull()
      .references(() => users.id),
    maxUses: integer('maxUses'),
    uses: integer('uses').notNull().default(0),
    expiresAt: integer('expiresAt'),
    createdAt: integer('createdAt').notNull()
  },
  (t) => ({
    codeIdx: uniqueIndex('invites_code_idx').on(t.code),
    creatorIdx: index('invites_creator_idx').on(t.creatorId)
  })
);

export {
  categories,
  channels,
  emojis,
  files,
  invites,
  logins,
  messageFiles,
  messageReactions,
  messages,
  notificationSounds,
  rolePermissions,
  roles,
  settings,
  users
};
