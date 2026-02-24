ALTER TABLE `settings` ADD `auth_token` text;
--> statement-breakpoint
UPDATE `settings`
SET `auth_token` = lower(hex(randomblob(32)))
WHERE `auth_token` IS NULL OR length(trim(`auth_token`)) = 0;
