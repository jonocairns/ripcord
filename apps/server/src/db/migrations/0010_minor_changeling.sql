ALTER TABLE `channels` ADD `voice_bitrate` integer DEFAULT 96000;--> statement-breakpoint
ALTER TABLE `channels` ADD `voice_fec_packet_loss_perc` integer DEFAULT 10;--> statement-breakpoint
ALTER TABLE `channels` ADD `voice_jitter_buffer_ms` integer DEFAULT 80;