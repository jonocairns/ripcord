DROP TABLE IF EXISTS `iptv_sources`;
DELETE FROM `channel_role_permissions` WHERE `permission` = 'MANAGE_IPTV';
DELETE FROM `channel_user_permissions` WHERE `permission` = 'MANAGE_IPTV';
