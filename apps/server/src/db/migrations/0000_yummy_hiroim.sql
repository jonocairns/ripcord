CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`type` text NOT NULL,
	`details` text,
	`ip` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activity_log_user_idx` ON `activity_log` (`userId`);--> statement-breakpoint
CREATE INDEX `activity_log_type_idx` ON `activity_log` (`type`);--> statement-breakpoint
CREATE INDEX `activity_log_created_idx` ON `activity_log` (`createdAt`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `categories_position_idx` ON `categories` (`position`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`topic` text,
	`password` text,
	`position` integer NOT NULL,
	`categoryId` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer,
	FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `channels_category_idx` ON `channels` (`categoryId`);--> statement-breakpoint
CREATE INDEX `channels_position_idx` ON `channels` (`position`);--> statement-breakpoint
CREATE TABLE `emojis` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`fileId` integer NOT NULL,
	`userId` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer,
	FOREIGN KEY (`fileId`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `emojis_name_unique` ON `emojis` (`name`);--> statement-breakpoint
CREATE INDEX `emojis_user_idx` ON `emojis` (`userId`);--> statement-breakpoint
CREATE INDEX `emojis_file_idx` ON `emojis` (`fileId`);--> statement-breakpoint
CREATE UNIQUE INDEX `emojis_name_idx` ON `emojis` (`name`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`originalName` text NOT NULL,
	`md5` text NOT NULL,
	`userId` integer NOT NULL,
	`size` integer NOT NULL,
	`mimeType` text NOT NULL,
	`extension` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `files_user_idx` ON `files` (`userId`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`creatorId` integer NOT NULL,
	`maxUses` integer,
	`uses` integer DEFAULT 0 NOT NULL,
	`expiresAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`creatorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code_unique` ON `invites` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code_idx` ON `invites` (`code`);--> statement-breakpoint
CREATE INDEX `invites_creator_idx` ON `invites` (`creatorId`);--> statement-breakpoint
CREATE TABLE `logins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`userAgent` text,
	`os` text,
	`device` text,
	`ip` text,
	`hostname` text,
	`city` text,
	`region` text,
	`country` text,
	`loc` text,
	`org` text,
	`postal` text,
	`timezone` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `logins_user_idx` ON `logins` (`userId`);--> statement-breakpoint
CREATE INDEX `logins_ip_idx` ON `logins` (`ip`);--> statement-breakpoint
CREATE TABLE `message_files` (
	`messageId` integer NOT NULL,
	`fileId` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer,
	PRIMARY KEY(`messageId`, `fileId`),
	FOREIGN KEY (`messageId`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fileId`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_files_msg_idx` ON `message_files` (`messageId`);--> statement-breakpoint
CREATE INDEX `message_files_file_idx` ON `message_files` (`fileId`);--> statement-breakpoint
CREATE TABLE `message_reactions` (
	`messageId` integer NOT NULL,
	`userId` integer NOT NULL,
	`emoji` text NOT NULL,
	`fileId` integer,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`messageId`, `userId`, `emoji`),
	FOREIGN KEY (`messageId`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fileId`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reaction_msg_idx` ON `message_reactions` (`messageId`);--> statement-breakpoint
CREATE INDEX `reaction_emoji_idx` ON `message_reactions` (`emoji`);--> statement-breakpoint
CREATE INDEX `reaction_user_idx` ON `message_reactions` (`userId`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content` text,
	`userId` integer NOT NULL,
	`channelId` integer NOT NULL,
	`metadata` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channelId`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_user_idx` ON `messages` (`userId`);--> statement-breakpoint
CREATE INDEX `messages_channel_idx` ON `messages` (`channelId`);--> statement-breakpoint
CREATE INDEX `messages_created_idx` ON `messages` (`createdAt`);--> statement-breakpoint
CREATE TABLE `notification_sounds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`fileId` integer NOT NULL,
	`userId` integer NOT NULL,
	`volume` integer NOT NULL,
	`enabled` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer,
	FOREIGN KEY (`fileId`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_sounds_type_unique` ON `notification_sounds` (`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_sounds_type_idx` ON `notification_sounds` (`type`);--> statement-breakpoint
CREATE INDEX `notification_sounds_user_idx` ON `notification_sounds` (`userId`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`roleId` integer NOT NULL,
	`permission` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer,
	PRIMARY KEY(`roleId`, `permission`),
	FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `role_permissions_role_idx` ON `role_permissions` (`roleId`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#ffffff' NOT NULL,
	`isPersistent` integer NOT NULL,
	`isDefault` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`name` text NOT NULL,
	`description` text,
	`password` text,
	`server_id` text NOT NULL,
	`secretToken` text,
	`logoId` integer,
	`allowNewUsers` integer DEFAULT true NOT NULL,
	`storageUploadsEnabled` integer DEFAULT true NOT NULL,
	`storageQuota` integer DEFAULT 107374182400 NOT NULL,
	`storageUploadMaxFileSize` integer DEFAULT 2147483648 NOT NULL,
	`storageSpaceQuotaByUser` integer DEFAULT 0 NOT NULL,
	`storageOverflowAction` text DEFAULT 'prevent' NOT NULL,
	FOREIGN KEY (`logoId`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `settings_server_idx` ON `settings` (`server_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identity` text NOT NULL,
	`password` text NOT NULL,
	`name` text NOT NULL,
	`avatarId` integer,
	`bannerId` integer,
	`roleId` integer NOT NULL,
	`bio` text,
	`banned` integer DEFAULT false NOT NULL,
	`banReason` text,
	`bannedAt` integer,
	`bannerColor` text,
	`lastLoginAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer,
	FOREIGN KEY (`avatarId`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bannerId`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_identity_unique` ON `users` (`identity`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_identity_idx` ON `users` (`identity`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`roleId`);