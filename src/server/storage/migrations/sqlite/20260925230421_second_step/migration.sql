CREATE TABLE `auth_two_factor` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`verified` integer DEFAULT 1 NOT NULL,
	`failed_verification_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	CONSTRAINT `fk_auth_two_factor_user_id_auth_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `auth_user` ADD `two_factor_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `auth_two_factor_user_id` ON `auth_two_factor` (`user_id`);