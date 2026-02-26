ALTER TABLE `settings` ADD `auth_token_secret` text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `settings`
SET `auth_token_secret` = lower(hex(randomblob(32)))
WHERE `auth_token_secret` = '';
