CREATE TABLE `push_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`installation_id` text NOT NULL,
	`expo_push_token` text NOT NULL,
	`platform` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `push_devices_user_idx` ON `push_devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `push_devices_installation_idx` ON `push_devices` (`installation_id`);--> statement-breakpoint
CREATE INDEX `push_devices_platform_idx` ON `push_devices` (`platform`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_user_installation_idx` ON `push_devices` (`user_id`,`installation_id`);