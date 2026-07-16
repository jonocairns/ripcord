ALTER TABLE `users` ADD COLUMN `required_value` text NOT NULL;
DELETE FROM `refresh_tokens`;
