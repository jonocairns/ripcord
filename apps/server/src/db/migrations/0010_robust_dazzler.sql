ALTER TABLE `channels` ADD `voice_bitrate` integer DEFAULT 96000;--> statement-breakpoint
ALTER TABLE `channels` ADD `voice_dtx` integer DEFAULT false;