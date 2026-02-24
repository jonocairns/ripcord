import {
  ChannelType,
  DEFAULT_ROLE_PERMISSIONS,
  getRandomString,
  OWNER_ROLE_ID,
  Permission,
  sha256,
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MIN_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  STORAGE_QUOTA,
  type TICategory,
  type TIChannel,
  type TIMessage,
  type TIRole,
  type TISettings,
  type TIUser
} from '@sharkord/shared';
import { randomUUIDv7 } from 'bun';
import chalk from 'chalk';
import crypto from 'crypto';
import { hashPassword } from '../helpers/password';
import { logger } from '../logger';
import { IS_DEVELOPMENT } from '../utils/env';
import { db } from './index';
import {
  categories,
  channels,
  invites,
  messages,
  roles,
  rolePermissions,
  settings,
  userRoles,
  users
} from './schema';

const seedDatabase = async () => {
  const needsSeeding = (await db.select().from(settings)).length === 0;

  if (!needsSeeding) return;

  logger.debug('Seeding initial database values...');

  const firstStart = Date.now();
  const originalToken = IS_DEVELOPMENT ? 'dev' : randomUUIDv7();
  const bootstrapInviteCode = IS_DEVELOPMENT ? undefined : getRandomString(24);

  const initialSettings: TISettings = {
    name: 'sharkord',
    description:
      'This is the default Sharkord description. Change me in the server settings!',
    password: '',
    serverId: Bun.randomUUIDv7(),
    secretToken: await sha256(originalToken),
    authToken: crypto.randomBytes(32).toString('hex'),
    allowNewUsers: IS_DEVELOPMENT,
    storageUploadEnabled: true,
    storageQuota: STORAGE_QUOTA,
    storageUploadMaxFileSize: STORAGE_MAX_FILE_SIZE,
    storageSpaceQuotaByUser: STORAGE_MIN_QUOTA_PER_USER,
    storageOverflowAction: STORAGE_OVERFLOW_ACTION,
    enablePlugins: false
  };

  await db.insert(settings).values(initialSettings);

  const initialCategories: TICategory[] = [
    {
      name: 'Text Channels',
      position: 1,
      createdAt: firstStart
    },
    {
      name: 'Voice Channels',
      position: 2,
      createdAt: firstStart
    }
  ];

  const initialChannels: TIChannel[] = [
    {
      type: ChannelType.TEXT,
      name: 'General Text',
      position: 0,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      categoryId: 1,
      topic: 'General text channel',
      createdAt: firstStart
    },
    {
      type: ChannelType.TEXT,
      name: 'General Text 2',
      position: 1,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      categoryId: 1,
      topic: 'General text channel 2',
      createdAt: firstStart
    },
    {
      type: ChannelType.VOICE,
      name: 'General Voice',
      position: 0,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      categoryId: 2,
      topic: 'General voice channel',
      createdAt: firstStart
    },
    {
      type: ChannelType.VOICE,
      name: 'General Voice 2',
      position: 1,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      categoryId: 2,
      topic: 'General voice channel 2',
      createdAt: firstStart
    }
  ];

  const initialRoles: TIRole[] = [
    {
      name: 'Owner',
      color: '#FFFFFF',
      isDefault: false,
      isPersistent: true,
      createdAt: firstStart
    },
    {
      name: 'Member',
      color: '#FFFFFF',
      isPersistent: true,
      isDefault: true,
      createdAt: firstStart
    }
  ];

  const initialUsers: TIUser[] = [
    {
      // In development, keep the bootstrap account identity predictable.
      identity: IS_DEVELOPMENT ? 'sharkord' : await sha256(randomUUIDv7()),
      name: 'Sharkord',
      avatarId: null,
      password: await hashPassword('sharkord'),
      bannerId: null,
      bio: 'Hey, I am Sharkord!',
      bannerColor:
        'linear-gradient(90deg, rgba(67,49,215,1) 30%, rgba(182,1,116,1) 100%)',
      createdAt: firstStart
    }
  ];

  const initialMessages: TIMessage[] = [
    {
      channelId: 1,
      content: '<p>Welcome to sharkord!</p>',
      metadata: null,
      userId: 1,
      createdAt: firstStart
    }
  ];

  const initialRolePermissions: {
    [roleId: number]: Permission[];
  } = {
    1: Object.values(Permission), // Owner (all permissions)
    2: DEFAULT_ROLE_PERMISSIONS // Member (default permissions)
  };

  await db.insert(categories).values(initialCategories);
  await db.insert(channels).values(initialChannels);
  await db.insert(roles).values(initialRoles);
  await db.insert(users).values(initialUsers);
  await db.insert(messages).values(initialMessages);

  if (bootstrapInviteCode) {
    await db.insert(invites).values({
      code: bootstrapInviteCode,
      creatorId: 1,
      maxUses: 1,
      uses: 0,
      expiresAt: null,
      createdAt: firstStart
    });
  }

  for (const [roleId, permissions] of Object.entries(initialRolePermissions)) {
    for (const permission of permissions) {
      await db.insert(rolePermissions).values({
        roleId: Number(roleId),
        permission,
        createdAt: Date.now()
      });
    }
  }

  await db.insert(userRoles).values({
    userId: 1,
    roleId: OWNER_ROLE_ID,
    createdAt: firstStart
  });

  const notice = [
    chalk.redBright.bold('🚨🚨 I M P O R T A N T 🚨🚨'),
    chalk.dim('────────────────────────────────────────────────────'),
    chalk.whiteBright('This server has been started for the first time.'),
    chalk.whiteBright(
      'Please save this access token somewhere safe, as it will not be shown again and there is no way to recover it.'
    ),
    chalk.whiteBright(
      'The access token below is used to gain admin privileges. Anyone with this token can take over the server.'
    ),
    ...(bootstrapInviteCode
      ? [
          chalk.whiteBright(
            'Open registration is disabled by default in production. Use the bootstrap invite code below to register your first account.'
          )
        ]
      : []),
    chalk.white('Please read the documentation on how to use this token.'),
    chalk.yellowBright('────────────────────────────────────────────────────'),
    chalk.bold.greenBright(originalToken),
    ...(bootstrapInviteCode
      ? [
          chalk.yellowBright('────────────────────────────────────────────────────'),
          chalk.whiteBright('Bootstrap invite code:'),
          chalk.bold.cyanBright(bootstrapInviteCode)
        ]
      : []),
    chalk.yellowBright('────────────────────────────────────────────────────')
  ].join('\n');

  console.log('\n%s\n', notice);
};

export { seedDatabase };
