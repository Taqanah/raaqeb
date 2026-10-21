CREATE TABLE `invitations` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL UNIQUE,
	`role` text NOT NULL,
	`token_hash` text NOT NULL UNIQUE,
	`invited_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_invitations_invited_by_auth_user_id_fk` FOREIGN KEY (`invited_by`) REFERENCES `auth_user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `auth_user` ADD `role` text DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_user` ADD `deactivated_at` integer;--> statement-breakpoint
ALTER TABLE `auth_user` ADD `last_sign_in_at` integer;--> statement-breakpoint
ALTER TABLE `auth_user` ADD `language` text;--> statement-breakpoint
ALTER TABLE `auth_user` ADD `time_zone` text;--> statement-breakpoint
ALTER TABLE `auth_user` ADD `clock` text;--> statement-breakpoint
ALTER TABLE `auth_user` ADD `calendar` text;--> statement-breakpoint
UPDATE auth_user SET role = 'owner';--> statement-breakpoint
UPDATE auth_user SET name = '' WHERE name = 'operator';--> statement-breakpoint
UPDATE auth_user SET language = (SELECT json_extract(value, '$') FROM settings WHERE key = 'operator_language'), time_zone = (SELECT json_extract(value, '$') FROM settings WHERE key = 'operator_time_zone'), clock = (SELECT json_extract(value, '$') FROM settings WHERE key = 'operator_clock'), calendar = (SELECT json_extract(value, '$') FROM settings WHERE key = 'operator_calendar');--> statement-breakpoint
DELETE FROM settings WHERE key IN ('operator_language', 'operator_time_zone', 'operator_clock', 'operator_calendar');--> statement-breakpoint
UPDATE settings SET key = 'auth_email_tested:' || (SELECT id FROM auth_user ORDER BY created_at LIMIT 1) WHERE key = 'auth_email_tested' AND EXISTS (SELECT 1 FROM auth_user);--> statement-breakpoint
DELETE FROM settings WHERE key = 'auth_email_tested';
