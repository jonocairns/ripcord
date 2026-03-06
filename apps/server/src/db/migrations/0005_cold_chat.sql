CREATE TABLE `iptv_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`playlist_url` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `iptv_sources_channel_id_unique` ON `iptv_sources` (`channel_id`);--> statement-breakpoint
CREATE INDEX `iptv_sources_channel_idx` ON `iptv_sources` (`channel_id`);
