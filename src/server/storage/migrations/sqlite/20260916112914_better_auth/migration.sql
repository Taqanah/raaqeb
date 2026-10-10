CREATE TABLE `auth_account` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`id_token` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_auth_account_user_id_auth_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `auth_session` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`token` text NOT NULL UNIQUE,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_auth_session_user_id_auth_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `auth_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `auth_user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_verification` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_account_user_id` ON `auth_account` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_session_user_id` ON `auth_session` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_verification_identifier` ON `auth_verification` (`identifier`);