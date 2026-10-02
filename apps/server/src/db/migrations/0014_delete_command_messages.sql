-- plugin commands no longer post messages; remove the legacy <command> rows.
-- their attributes were built without escaping, so they can't be trusted or rendered.
-- deleting a row nulls read pointers on it, which counts the whole channel as unread,
-- so first move those pointers back to the newest earlier message that survives.
UPDATE `channel_read_states` SET `last_read_message_id` = (
	SELECT MAX(`m`.`id`) FROM `messages` `m`
	WHERE `m`.`channel_id` = `channel_read_states`.`channel_id`
		AND `m`.`id` < `channel_read_states`.`last_read_message_id`
		AND (`m`.`content` IS NULL OR `m`.`content` NOT LIKE '<command %')
)
WHERE `last_read_message_id` IN (SELECT `id` FROM `messages` WHERE `content` LIKE '<command %');
--> statement-breakpoint
-- message_files and message_reactions cascade from messages.
DELETE FROM `messages` WHERE `content` LIKE '<command %';
