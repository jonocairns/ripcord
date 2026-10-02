-- plugin commands no longer post messages; remove the legacy <command> rows.
-- their attributes were built without escaping, so they can't be trusted or rendered.
-- message_files, message_reactions and read states cascade from messages.
DELETE FROM `messages` WHERE `content` LIKE '<command %';
